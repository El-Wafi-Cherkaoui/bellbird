import { frequencyOf } from "./notes.js";
import { lengthMs, renderSamples, type Tone } from "./synth.js";

// How a cue behaves next to others:
// - "tick": tiny feedback (moving a cursor). Skipped if anything else is playing.
// - "normal": plays over others.
// - "alert": cuts what is playing, and nothing else interrupts it.
export type CueKind = "tick" | "normal" | "alert";

export type NoteSpec = {
  // A note name ("C5", "F#4", "Bb3") or a frequency in Hz.
  note: string | number;
  // When the note starts, in ms from the start of the cue. Default 0.
  at?: number;
  // How long the note rings, in ms.
  ms: number;
};

export type CueSpec = {
  notes: NoteSpec[];
  // 0 to 1. Default 0.22, which is gentle on laptop speakers.
  volume?: number;
  kind?: CueKind;
};

export type Cue = {
  name: string;
  tones: Tone[];
  volume: number;
  kind: CueKind;
  durationMs: number;
};

const maxVolume = 0.6;
const maxLengthMs = 3_000;
const namePattern = /^[a-z][a-z0-9-]{0,31}$/;

// Every built-in cue uses notes from the C major pentatonic scale
// (C, D, E, G, A), so any two cues played back to back sound good together.
export const builtInCues: Record<string, CueSpec> = {
  open: { notes: [{ note: "C5", ms: 140 }, { note: "G5", at: 70, ms: 200 }], volume: 0.22 },
  close: { notes: [{ note: "G5", ms: 140 }, { note: "C5", at: 70, ms: 200 }], volume: 0.2 },
  start: { notes: [{ note: "C5", ms: 150 }, { note: "E5", at: 80, ms: 220 }], volume: 0.22 },
  stop: { notes: [{ note: "E5", ms: 150 }, { note: "C5", at: 80, ms: 220 }], volume: 0.2 },
  success: { notes: [{ note: "C5", ms: 140 }, { note: "E5", at: 70, ms: 160 }, { note: "G5", at: 140, ms: 320 }], volume: 0.22 },
  error: { notes: [{ note: "A4", ms: 150 }, { note: "E4", at: 140, ms: 340 }], volume: 0.24 },
  attention: {
    notes: [
      { note: "E5", ms: 320 },
      { note: "A5", ms: 320 },
      { note: "C5", at: 220, ms: 520 },
      { note: "G5", at: 220, ms: 520 },
    ],
    volume: 0.26,
    kind: "alert",
  },
};

export function buildCue(name: string, spec: CueSpec): Cue {
  if (!namePattern.test(name)) {
    throw new TypeError(`bellbird: "${name}" can't be a cue name. Use lowercase letters, digits and dashes, starting with a letter (max 32).`);
  }

  if (!Array.isArray(spec.notes) || spec.notes.length === 0) {
    throw new TypeError(`bellbird: cue "${name}" needs at least one note.`);
  }

  const tones = spec.notes.map((note): Tone => {
    const startMs = note.at ?? 0;

    if (!(startMs >= 0) || !(note.ms > 0)) {
      throw new RangeError(`bellbird: in cue "${name}", "at" must be 0 or more and "ms" more than 0.`);
    }

    return { frequency: frequencyOf(note.note), startMs, durationMs: note.ms };
  });

  const volume = spec.volume ?? 0.22;
  const durationMs = lengthMs(tones);

  if (!(volume > 0 && volume <= maxVolume)) {
    throw new RangeError(`bellbird: cue "${name}" volume must be above 0 and at most ${maxVolume}.`);
  }

  if (durationMs > maxLengthMs) {
    throw new RangeError(`bellbird: cue "${name}" is ${durationMs} ms long; cues can be at most ${maxLengthMs} ms.`);
  }

  return { name, tones, volume, kind: spec.kind ?? "normal", durationMs };
}

// The cues a player knows, with their rendered audio cached.
export type CueSet = {
  get(name: string): Cue | undefined;
  names(): string[];
  define(name: string, spec: CueSpec): Cue;
  samples(name: string): Int16Array;
};

export function createCueSet(): CueSet {
  const cues = new Map<string, Cue>();
  const rendered = new Map<string, Int16Array>();

  for (const [name, spec] of Object.entries(builtInCues)) {
    cues.set(name, buildCue(name, spec));
  }

  return {
    get: (name) => cues.get(name),
    names: () => [...cues.keys()],
    define(name, spec) {
      const cue = buildCue(name, spec);

      cues.set(name, cue);
      rendered.delete(name);

      return cue;
    },
    samples(name) {
      let samples = rendered.get(name);

      if (samples === undefined) {
        const cue = cues.get(name);

        if (cue === undefined) {
          throw new RangeError(`bellbird: there is no cue named "${name}".`);
        }

        samples = renderSamples(cue.tones, cue.volume);
        rendered.set(name, samples);
      }

      return samples;
    },
  };
}
