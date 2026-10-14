// Writes every built-in cue to assets/sounds/<name>.wav, to listen to or
// link from the README. Run `npm run build` first.
import { mkdirSync, writeFileSync } from "node:fs";
import { builtInCues, renderWav } from "../dist/index.js";

const folder = new URL("../assets/sounds/", import.meta.url);

mkdirSync(folder, { recursive: true });

for (const name of Object.keys(builtInCues)) {
  writeFileSync(new URL(`${name}.wav`, folder), renderWav(name));
  console.log(`assets/sounds/${name}.wav`);
}
