import { describe, it, expect } from "vitest";
import { int16ToFloat32 } from "../asr/sherpa-onnx.js";
import { getASRProvider, disposeASRProvider } from "../asr/index.js";
import type { XiaozhiAccount } from "../config.js";

describe("int16ToFloat32", () => {
  it("converts zero buffer to all-zeros float32", () => {
    const buf = Buffer.alloc(4);
    const out = int16ToFloat32(buf);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  it("converts int16 max (32767) to ~1.0", () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16LE(32767, 0);
    const out = int16ToFloat32(buf);
    expect(out[0]).toBeCloseTo(1.0, 4);
  });

  it("converts int16 min (-32768) to -1.0", () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16LE(-32768, 0);
    const out = int16ToFloat32(buf);
    expect(out[0]).toBe(-1.0);
  });

  it("handles 16kHz frame size (960 samples)", () => {
    const buf = Buffer.alloc(960 * 2);
    for (let i = 0; i < 960; i++) buf.writeInt16LE(i % 100, i * 2);
    const out = int16ToFloat32(buf);
    expect(out.length).toBe(960);
    expect(out[0]).toBeCloseTo(0, 5);
  });
});

describe("getASRProvider", () => {
  it("returns mock provider for provider=mock", () => {
    const account = {
      asr: { provider: "mock" as const, options: {} },
    } as unknown as XiaozhiAccount;
    const provider = getASRProvider(account);
    expect(provider.name).toBe("mock");
    expect(provider.transcribe(Buffer.alloc(0))).resolves.toMatchObject({
      text: expect.stringMatching(/\[mock-asr-call-\d+\]/),
    });
  });

  it("throws on unknown provider", () => {
    const account = {
      asr: { provider: "unknown" as never, options: {} },
    } as unknown as XiaozhiAccount;
    expect(() => getASRProvider(account)).toThrow(/unknown ASR provider/);
  });

  it("throws on cloud provider (not yet implemented)", () => {
    const account = {
      asr: { provider: "cloud" as const, options: {} },
    } as unknown as XiaozhiAccount;
    expect(() => getASRProvider(account)).toThrow(/not yet implemented/);
  });

  it("throws on sherpa_onnx without modelDir", () => {
    const account = {
      asr: { provider: "sherpa_onnx" as const, options: {} },
    } as unknown as XiaozhiAccount;
    expect(() => getASRProvider(account)).toThrow(/modelDir is required/);
  });

  it("caches the provider on repeated calls with same config", () => {
    disposeASRProvider();
    const account = {
      asr: { provider: "mock" as const, options: {} },
    } as unknown as XiaozhiAccount;
    const a = getASRProvider(account);
    const b = getASRProvider(account);
    expect(a).toBe(b);
  });
});
