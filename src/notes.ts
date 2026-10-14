const semitones: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

// Turns a note name like "C5", "F#4" or "Bb3" into its frequency in Hz
// (equal temperament, A4 = 440 Hz). Numbers are taken as Hz already.
export function frequencyOf(note: string | number): number {
  if (typeof note === "number") {
    if (!Number.isFinite(note) || note < 20 || note > 20_000) {
      throw new RangeError(`bellbird: ${note} Hz is outside what people can hear (20–20000 Hz).`);
    }

    return note;
  }

  const match = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note.trim());

  if (match === null) {
    throw new TypeError(`bellbird: "${note}" is not a note. Use a name like "C5", "F#4" or "Bb3", or a number in Hz.`);
  }

  const [, letter, accidental, octave] = match;
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  const fromA4 = semitones[letter!.toUpperCase()]! + shift + (Number(octave) - 4) * 12;

  return frequencyOf(Math.round(440 * 2 ** (fromA4 / 12) * 100) / 100);
}
