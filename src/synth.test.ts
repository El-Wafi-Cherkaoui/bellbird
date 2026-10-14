import { describe, expect, it } from "vitest";
import { mixSamples, renderSamples, toWav } from "./synth.js";

describe("renderSamples / toWav", () => {
  const wav = toWav(renderSamples([{ frequency: 440, startMs: 0, durationMs: 100 }], 0.2));
  const samples = (buffer: Buffer) => Array.from({ length: (buffer.length - 44) / 2 }, (_, index) => buffer.readInt16LE(44 + index * 2));

  it("writes a valid 16-bit mono WAV", () => {
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.length - 44).toBe(Math.ceil(0.1 * 22_050) * 2);
  });

  it("starts and ends silent so nothing clicks", () => {
    const values = samples(wav);

    expect(Math.abs(values[0]!)).toBeLessThan(50);
    expect(Math.abs(values.at(-1)!)).toBeLessThan(50);
  });

  it("never gets louder than the requested volume", () => {
    const peak = Math.max(...samples(wav).map(Math.abs));

    expect(peak).toBeLessThanOrEqual(Math.round(0.2 * 32767));
    expect(peak).toBeGreaterThan(0.1 * 32767);
  });
});

describe("mixSamples", () => {
  it("adds overlapping parts and clamps instead of wrapping around", () => {
    const mixed = mixSamples([
      { samples: Int16Array.from([100, 30_000, 30_000]), offset: 0 },
      { samples: Int16Array.from([50, 30_000]), offset: 1 },
    ]);

    expect(Array.from(mixed)).toEqual([100, 30_050, 32_767]);
  });

  it("is as long as the longest part", () => {
    expect(mixSamples([{ samples: new Int16Array(3), offset: 0 }, { samples: new Int16Array(2), offset: 4 }])).toHaveLength(6);
  });
});
