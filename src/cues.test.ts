import { describe, expect, it } from "vitest";
import { buildCue, builtInCues, createCueSet } from "./cues.js";
import { frequencyOf } from "./notes.js";
import { renderWav } from "./render.js";

describe("frequencyOf", () => {
  it("turns note names into equal-temperament frequencies", () => {
    expect(frequencyOf("A4")).toBe(440);
    expect(frequencyOf("C5")).toBe(523.25);
    expect(frequencyOf("a5")).toBe(880);
    expect(frequencyOf("F#4")).toBe(369.99);
    expect(frequencyOf("Bb3")).toBe(233.08);
    expect(frequencyOf(1000)).toBe(1000);
  });

  it("explains what a note looks like when given something else", () => {
    expect(() => frequencyOf("H2")).toThrow(/C5/);
    expect(() => frequencyOf(5)).toThrow(/20–20000/);
  });
});

describe("built-in cues", () => {
  it("are all quiet and short", () => {
    for (const [name, spec] of Object.entries(builtInCues)) {
      const cue = buildCue(name, spec);

      expect(cue.volume).toBeLessThanOrEqual(0.3);
      expect(cue.durationMs).toBeLessThanOrEqual(800);
    }
  });

  it("stay on one pentatonic scale, so any two sound good together", () => {
    const allowed = new Set(["C", "D", "E", "G", "A"]);

    for (const spec of Object.values(builtInCues)) {
      for (const note of spec.notes) {
        expect(allowed).toContain(String(note.note)[0]);
      }
    }
  });

  it("include exactly one alert", () => {
    const kinds = Object.values(builtInCues).map((spec) => spec.kind ?? "normal");

    expect(kinds.filter((kind) => kind === "alert")).toHaveLength(1);
    expect(kinds).not.toContain("tick");
  });
});

describe("custom cues", () => {
  it("can be added and replace built-ins, and the audio is re-rendered", () => {
    const set = createCueSet();
    const before = set.samples("success");

    set.define("deploy", { notes: [{ note: "C5", ms: 100 }, { note: "G5", at: 50, ms: 100 }] });
    set.define("success", { notes: [{ note: "A5", ms: 300 }] });

    expect(set.names()).toContain("deploy");
    expect(set.get("deploy")!.durationMs).toBe(150);
    expect(set.samples("success")).not.toBe(before);
    expect(set.samples("success")).toHaveLength(Math.ceil(0.3 * 22_050));
  });

  it("reject names that can't travel safely to helpers and file names", () => {
    const set = createCueSet();

    for (const name of ["", "Deploy", "two words", "../x", "a".repeat(40)]) {
      expect(() => set.define(name, { notes: [{ note: "C5", ms: 100 }] })).toThrow(/cue name/);
    }
  });

  it("reject specs that would be silent, deafening or endless", () => {
    expect(() => buildCue("x", { notes: [] })).toThrow(/at least one note/);
    expect(() => buildCue("x", { notes: [{ note: "C5", ms: 0 }] })).toThrow(/ms/);
    expect(() => buildCue("x", { notes: [{ note: "C5", ms: 100 }], volume: 1 })).toThrow(/volume/);
    expect(() => buildCue("x", { notes: [{ note: "C5", at: 3_000, ms: 100 }] })).toThrow(/3000 ms/);
  });
});

describe("renderWav", () => {
  it("renders built-in and custom cues to WAV bytes", () => {
    expect(renderWav("success").toString("ascii", 0, 4)).toBe("RIFF");
    expect(renderWav({ notes: [{ note: "E5", ms: 50 }] }).length).toBe(44 + Math.ceil(0.05 * 22_050) * 2);
  });

  it("only knows real built-in names", () => {
    expect(() => renderWav("toString")).toThrow(/no built-in cue/);
  });
});
