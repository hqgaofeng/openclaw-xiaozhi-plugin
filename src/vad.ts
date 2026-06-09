/**
 * Server-side VAD watcher (M3.7.3).
 *
 * Mirrors the role that the official xiaozhi-esp32-server
 * (core/providers/vad/silero.py + core/handle/receiveAudioHandle.py)
 * plays for the realtime / auto listen modes: read each opus frame as
 * it arrives, decide if it contains speech, and trigger a virtual
 * ListenMessage(stop) once the user has been silent for ≥ 1s.
 *
 * Why we need this:
 *   xiaozhi-esp32 firmware with `CONFIG_USE_DEVICE_AEC=y` (Allen 板子
 *   实际就是这条 sdkconfig) sets `listening_mode_ = kListeningModeRealtime`
 *   in application.cc. That mode never sends a ListenMessage(stop) on
 *   its own — the user has to either say the wake word again or press
 *   the touch key. We don't want to require the user to either, so we
 *   run our own VAD and synthesize a stop when we detect a 1s silence.
 *
 * Why RMS energy and not silero ONNX:
 *   - We don't ship an onnx model with the plugin and V2 #2.1 already
 *     proved the VPS can't fit a 200-300MB model. RMS-energy is good
 *     enough for "is the user still talking?" on a quiet-enough
 *     environment, and the esp32 is usually a couple of inches from
 *     the mouth.
 *   - The "official" silero path is energy-based under the hood for
 *     the silence-vs-speech threshold (they just bolt an ONNX
 *     classifier on top); for the trigger condition alone, RMS is
 *     equivalent.
 *
 * Thresholds (tuned to esp32 16kHz mic, 60ms frames, int16):
 *   - SILENCE_RMS_THRESHOLD = 600
 *       ~ 14-bit effective, well below typical speech (2000-8000)
 *   - SPEECH_DEBOUNCE_MS = 200
 *       need to see at least 200ms of speech before we treat the turn
 *       as "started" (avoids noise blips)
 *   - SILENCE_DEBOUNCE_MS = 1000
 *       1s of silence after speech is enough to trigger stop — matches
 *       the official silero's `silence_threshold_ms` default
 *
 * The watcher is started by `inbound.ts` whenever a ListenMessage
 * (start) arrives in `auto` or `realtime` mode, and is stopped when:
 *   - A new listen.start arrives (start a new watcher)
 *   - A listen.stop arrives (esp32 took over — let it close us)
 *   - The connection closes
 *   - VAD silence-debounce window passes (calls onSilence)
 *
 * onSilence is the callback in inbound.ts that synthesizes a stop —
 * typically `() => handleListenStop(ctx, session)`.
 */

import { OpusCodec } from "./audio.js";
import type { SessionContext } from "./session.js";

/** Anything below this RMS counts as silence (int16 domain). */
const SILENCE_RMS_THRESHOLD = 600;
/** Silence that long after speech = trigger stop. */
const SILENCE_DEBOUNCE_MS = 600;
/** How often to poll for silence-debounce expiry (independent of frame rate). */
const TICK_INTERVAL_MS = 30;
/** Hard cap on a single turn: no matter what, stop after this many seconds. */
const MAX_TURN_MS = 4000;
/** Trigger stop after this much time even if we never saw any speech. */
const SILENT_START_TIMEOUT_MS = 1500;

export interface VadWatcher {
  stop(): void;
}

export interface VadWatcherOpts {
  deviceId: string;
  session: SessionContext;
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
  /** Called once when 1s silence is observed after ≥200ms of speech. */
  onSilence: () => void | Promise<void>;
}

/**
 * Start a VAD watcher on the given session. The watcher:
 *   1. Hooks `session.audioBuffer` (which `appendAudioFrame` already
 *      pushes into on the inbound message loop) — does NOT touch the
 *      WebSocket.
 *   2. Periodically walks the *unprocessed* tail of the audio buffer,
 *      decodes each frame, computes RMS, and updates the speech/silence
 *      debounce windows.
 *   3. Calls onSilence() once when 600ms of silence follows speech.
 *
 * Returns a handle with `stop()` to detach the watcher (idempotent).
 */
export function startVadWatcher(opts: VadWatcherOpts): VadWatcher {
  const { deviceId, session, log, onSilence } = opts;
  let stopped = false;
  let processedFrames = 0;       // index into audioBuffer we've already VAD'd
  let lastSpeechAt = 0;          // ms timestamp of the most recent speech frame
  let turnStarted = false;       // have we observed enough speech to call this a turn
  let silenceFired = false;      // have we already triggered onSilence for this turn
  const listenStartedAt = Date.now();

  // Use the session's existing mic decoder (16kHz, mono) — esp32 hello
  // echoes audio_params so this matches what handleListenStop will use.
  const decoder = new OpusCodec(16000, 1);

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    const total = session.audioBuffer.length;

    // Walk any new frames we haven't seen yet
    for (let i = processedFrames; i < total; i++) {
      const frame = session.audioBuffer[i];
      let pcm: Buffer;
      try {
        pcm = decoder.decode(frame);
      } catch (err) {
        // Bad opus frame (rare). Skip and continue.
        continue;
      }
      const rms = computeRms(pcm);
      if (rms >= SILENCE_RMS_THRESHOLD) {
        lastSpeechAt = now;
        if (!turnStarted) {
          // First speech in this turn — silence window is measured
          // from the most recent speech, not from the first one.
          turnStarted = true;
        }
        silenceFired = false; // reset the latch on new speech
      } else if (turnStarted && !silenceFired) {
        if (now - lastSpeechAt >= SILENCE_DEBOUNCE_MS) {
          silenceFired = true;
          log.info(
            `xiaozhi: ${deviceId} VAD silence ${SILENCE_DEBOUNCE_MS}ms after ` +
            `speech (${total} frames total) — triggering virtual stop`,
          );
          // Fire and forget — the callback handles the rest of the
          // pipeline (ASR → dispatch → TTS) and will reset our state
          // via transitionTo(session, "THINKING") on the main path.
          void onSilence();
          return;
        }
      }
    }
    processedFrames = total;

    // Fallback A: if we never saw any speech within SILENT_START_TIMEOUT_MS
    // of the listen.start, just give up and stop. esp32's own AFE VAD
    // only flips an LED in listening mode; it never sends a
    // ListenMessage(stop), so without this fallback the session would
    // stay open forever if the user doesn't say anything.
    if (!silenceFired && !turnStarted && now - listenStartedAt >= SILENT_START_TIMEOUT_MS) {
      silenceFired = true;
      log.info(
        `xiaozhi: ${deviceId} VAD silent-start timeout ${SILENT_START_TIMEOUT_MS}ms ` +
        `(${total} frames, never saw speech) — triggering virtual stop`,
      );
      void onSilence();
      return;
    }
    // Fallback B: hard turn cap so a runaway never holds the session
    // open indefinitely.
    if (!silenceFired && now - listenStartedAt >= MAX_TURN_MS) {
      silenceFired = true;
      log.info(
        `xiaozhi: ${deviceId} VAD max-turn timeout ${MAX_TURN_MS}ms ` +
        `(${total} frames) — triggering virtual stop`,
      );
      void onSilence();
      return;
    }
  };


  const interval = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the Node process alive just for VAD ticks
  if (typeof (interval as { unref?: () => void }).unref === "function") {
    (interval as { unref: () => void }).unref();
  }

  log.info(
    `xiaozhi: ${deviceId} VAD watcher started (mode=${session.clientListenMode ?? "?"}, ` +
    `silence_threshold=${SILENCE_RMS_THRESHOLD}, ` +
    `silence_debounce=${SILENCE_DEBOUNCE_MS}ms)`,
  );

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      session.vadWatcher = null;
      log.debug(`xiaozhi: ${deviceId} VAD watcher stopped`);
    },
  };
}

/**
 * RMS of an int16 little-endian buffer. Range: 0 .. 32768.
 * A typical "loud speech" frame sits in the 2000-8000 range; ambient
 * room noise in a quiet office is ~50-300. Threshold of 600 is
 * conservative — prefer false-negatives (missed VAD stop) over false
 * positives (cut user off mid-sentence).
 */
export function computeRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Bug 5 fix: peek into the unprocessed audio buffer and return
 * true if any frame has RMS above SILENCE_RMS_THRESHOLD.
 *
 * Used by the post-TTS grace window to decide whether an
 * in-grace VAD stop should be suppressed (likely echo) or
 * dispatched (user is actually talking over the echo).
 *
 * Cheap: only decodes the last N frames (not the whole buffer).
 */
export function bufferHasSpeech(session: SessionContext): boolean {
  // Lazy-import-free: instantiate a decoder on the same sample rate
  // the session is using (16kHz mic).
  const decoder = new OpusCodec(16000, 1);
  const buf = session.audioBuffer;
  // Only look at the last 10 frames (≈600ms of audio) — that's
  // enough to detect "user is actually talking".
  const start = Math.max(0, buf.length - 10);
  for (let i = start; i < buf.length; i++) {
    try {
      const pcm = decoder.decode(buf[i]);
      if (computeRms(pcm) >= SILENCE_RMS_THRESHOLD) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
