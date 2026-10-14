import { buildCue, builtInCues, type CueSpec } from "./cues.js";
import { renderSamples, toWav } from "./synth.js";

// Renders a cue (a built-in name, or your own spec) to a WAV file's bytes,
// for apps that want to ship or play the sounds some other way.
export function renderWav(cue: string | CueSpec): Buffer {
  const spec = typeof cue !== "string" ? cue : Object.hasOwn(builtInCues, cue) ? builtInCues[cue] : undefined;

  if (spec === undefined) {
    throw new RangeError(`bellbird: there is no built-in cue named "${String(cue)}".`);
  }

  const built = buildCue(typeof cue === "string" ? cue : "custom", spec);

  return toWav(renderSamples(built.tones, built.volume));
}
