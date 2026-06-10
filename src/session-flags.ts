/**
 * Multi-flag state machine helpers — v0.4.0-rc3 (batch 3).
 *
 * Allen 15:39 GMT+8 拍板: 4 个新 flag 加到 SessionContext,但默认
 * 全部 false / undefined,只有 useMultiFlagState=true 时才启用。
 *
 * 4 new flags on SessionContext:
 *   - clientHaveVoice: boolean    — esp32 has actually pushed voice frames
 *   - clientVoiceStop: boolean    — esp32 has explicitly said voice stop
 *   - lastIsVoice:    boolean    — most recent VAD decision was "voice"
 *   - vadLastVoiceTime: number    — ms timestamp of last voice frame
 *
 * The flags live on SessionContext (set in createSessionContext).
 * This module exposes:
 *   - getMultiFlagStateEnabled() — the runtime gate
 *   - setClientHaveVoice(session, value)
 *   - setClientVoiceStop(session, value)
 *   - setLastIsVoice(session, value)
 *   - setVadLastVoiceTime(session, value)
 *   - resetMultiFlagState(session)
 *
 * Helpers are intentionally simple: they just set the field. The
 * feature gate is a separate read-only function callers check BEFORE
 * mutating. This matches the metricsEnabled pattern (api.ts:71).
 *
 * The 4 flags are independent — any combination is valid, no
 * cross-flag validation. State transitions (IDLE→LISTENING etc.) are
 * NOT affected; the existing transitionTo() in session.ts is the
 * single source of truth for `session.state`.
 */

import type { SessionContext } from "./session.js";
import { getUseMultiFlagState } from "./api.js";

/**
 * Returns true if the multi-flag state machine is enabled in cfg.
 * This is a runtime read — it picks up live config changes without
 * requiring a plugin restart.
 */
export function getMultiFlagStateEnabled(): boolean {
  return getUseMultiFlagState();
}

/** Mark the session as having received voice frames from the client. */
export function setClientHaveVoice(session: SessionContext, value: boolean): void {
  session.clientHaveVoice = value;
}

/** Mark the session as having received an explicit voice-stop signal. */
export function setClientVoiceStop(session: SessionContext, value: boolean): void {
  session.clientVoiceStop = value;
}

/** Record the most recent VAD decision. */
export function setLastIsVoice(session: SessionContext, value: boolean): void {
  session.lastIsVoice = value;
}

/** Record the timestamp of the most recent voice frame (Date.now() ms). */
export function setVadLastVoiceTime(session: SessionContext, value: number): void {
  session.vadLastVoiceTime = value;
}

/** Reset all 4 flags to their default values. */
export function resetMultiFlagState(session: SessionContext): void {
  session.clientHaveVoice = false;
  session.clientVoiceStop = false;
  session.lastIsVoice = false;
  session.vadLastVoiceTime = 0;
}
