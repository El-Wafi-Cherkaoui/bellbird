# bellbird

[![npm](https://img.shields.io/npm/v/bellbird)](https://www.npmjs.com/package/bellbird)
[![CI](https://github.com/El-Wafi-Cherkaoui/bellbird/actions/workflows/ci.yml/badge.svg)](https://github.com/El-Wafi-Cherkaoui/bellbird/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

Soft sound cues for Node CLIs and terminal apps.

Your app gets small, pleasant sounds for success, error, attention and other events. No audio files ship with it and it has no dependencies: every cue is synthesized in code. On Linux and Windows a cue starts with a short, steady delay instead of the usual few hundred milliseconds.

bellbird is not a music player, an audio file player, a text-to-speech tool or a desktop notification library.

> Named after the bellbird, a small songbird whose call sounds like a ringing bell.

## Status

0.1.0, first release. Requires Node.js 20+.

The sound design, the Linux audio stream and the file fallback come from [Sable](https://github.com/El-Wafi-Cherkaoui/Sable), where they are in daily use. The Windows helper is new in this release.

| Platform | How cues play | Delay per cue |
| --- | --- | --- |
| Linux | one audio stream kept open (`pacat`, `paplay`, `pw-cat` or `aplay`) | fixed, about 100 ms |
| Windows | one hidden PowerShell process kept open, cues preloaded in memory | well under 1 ms to reach the helper, plus Windows' audio buffer |
| macOS | `afplay`, one launch per cue | slower; low-latency mode not yet implemented, contributions welcome |

If the fast way can't start (no sound server, PowerShell locked down), bellbird falls back to playing a small WAV file per cue. If that fails too, it goes silent. Sound problems never throw and never print to the terminal.

## Install

```sh
npm install bellbird
```

## Use it in your app

```ts
import { bellbird } from "bellbird";

const sound = bellbird();

sound.play("success");
sound.play("error");
sound.play("attention"); // cuts what is playing; nothing interrupts it

// When your app exits:
sound.close();
```

`play()` returns at once. Use `await sound.playAndWait("success")` when you want the sound to finish before your process exits.

**Create one player and reuse it.** `bellbird()` starts a helper process (on Linux and Windows), so call it once when your app starts, not every time you play a sound.

TypeScript types are included. bellbird is an ES module: from CommonJS, `require("bellbird")` works on Node 20.19+ and 22.12+; on older versions use `const { bellbird } = await import("bellbird")`.

### Recipe: a script that plays a sound when it's done

For a build script or a one-shot CLI command. The process exits right after, so wait for the sound to finish first.

```ts
import { bellbird } from "bellbird";

// Leave `enabled` out unless the user asked for silence, so BELLBIRD=0 and CI are respected.
const sound = bellbird(process.argv.includes("--quiet") ? { enabled: false } : {});

try {
  await runTheBuild();
  await sound.playAndWait("success");
} catch (error) {
  console.error(error);
  await sound.playAndWait("error");
  process.exitCode = 1;
} finally {
  sound.close();
}
```

### Recipe: a long-running app (TUI, dev server, watcher)

Make one player in its own module and import it wherever you need sound.

```ts
// sound.ts
import { bellbird, soundAllowed } from "bellbird";
import { settings } from "./settings.js";

// Your app's own sound setting, and BELLBIRD=0 / CI still win.
export const sound = bellbird({ enabled: settings.sound && soundAllowed() });

process.on("exit", () => sound.close());
```

```ts
// anywhere else
import { sound } from "./sound.js";

sound.play("start");            // a server or task started
sound.play("attention");        // something crashed or needs the user
sound.setEnabled(false);        // the user turned sound off in your settings
```

If your app handles Ctrl+C itself, call `sound.close()` there too. If it doesn't, the helper notices that your app is gone and exits on its own.

### Built-in cues

| Cue | Sounds like | For |
| --- | --- | --- |
| `open` / `close` | two notes, up / down | opening and leaving a screen |
| `start` / `stop` | two notes, up / down | starting and stopping something |
| `success` | three rising notes | a task finished |
| `error` | two falling notes, lower | a task failed |
| `attention` | a soft two-chord chime | something needs the user now |

Every built-in cue uses notes from one pentatonic scale, so any two of them sound good played back to back. Listen to them in [`assets/sounds`](assets/sounds), or run `npx bellbird demo`.

### Your own cues

```ts
sound.define("deploy", {
  notes: [
    { note: "C5", ms: 150 },
    { note: "G5", at: 80, ms: 260 },
  ],
  volume: 0.22,
});

sound.play("deploy");
```

- `note` is a note name (`"C5"`, `"F#4"`, `"Bb3"`) or a frequency in Hz.
- `at` is when the note starts, in ms from the start of the cue. Notes can overlap.
- `volume` goes from 0 to 0.6. The default is 0.22, which is gentle on laptop speakers.
- `kind` is `"normal"` (default), `"tick"` (for tiny, frequent feedback like moving through a list: skipped while anything else plays) or `"alert"` (cuts other sounds and is never interrupted).

Defining a cue with a built-in name replaces that cue.

### Rules that keep it pleasant

- A cue of kind `tick` never plays over another sound, and ticks less than 60 ms apart are merged.
- The same cue played twice within 100 ms plays once.
- An `alert` fades out what is playing over 10 ms, so it doesn't click.

### Turning sound off

- `BELLBIRD=0` silences every app that uses bellbird. `BELLBIRD=1` turns it on.
- In CI (`CI` is set), sound is off unless `BELLBIRD=1`.
- `bellbird({ enabled: false })` and `sound.setEnabled(false)` control it in code. Give your users a setting for it.

### Other API

```ts
sound.cues();              // names of every cue
await sound.ready();       // resolves once cues play without a start-up delay
sound.output();            // "stream" | "helper" | "files" | "none"

import { renderWav } from "bellbird";
renderWav("success");      // WAV bytes, to save or play another way
```

## Command line

```sh
npx bellbird success            # play a cue
npx bellbird list               # list the cues
npx bellbird demo               # play all of them

# Run a command, then play success or error depending on its exit code.
npx bellbird wrap -- npm run build
npx bellbird wrap --min 30 -- npm test   # only if it took 30 s or more
```

`wrap` keeps the command's output and exit code, so it is safe in scripts.

## How it works

Every cue is a few sine notes with a soft attack and an exponential fade, rendered to 16-bit audio at 22,050 Hz when the app starts. Nothing is downloaded or read from disk.

Starting a player program for every sound is what makes most terminal sound slow and uneven. bellbird starts one long-lived process instead:

- **Linux:** a raw audio stream into `pacat`, `paplay`, `pw-cat` or `aplay`, whichever works. bellbird mixes the cues itself and keeps the audio 60 ms ahead of playback, so every cue has the same short delay.
- **Windows:** a hidden Windows PowerShell 5.1 process, which every Windows 10 and 11 machine has. Each cue is loaded into it once as an in-memory sound, then playing a cue is one short line on its stdin. Windows' simple player can only play one sound at a time, so when cues overlap, bellbird mixes the rest of the current sound with the new cue and sends that as one sound.

Neither process keeps your app running, and both are stopped by `close()`.

## Measure it

```sh
npx bellbird bench
```

This compares bellbird's long-lived process with launching a player for every cue, on your machine. You will hear some soft sounds.

On a Windows desktop:

```text
bellbird helper (PowerShell, kept open)
  start-up, once:   225 ms
  per cue:          p50 0.3 ms · p95 0.4 ms · max 4.1 ms (20 runs)

Baseline: one powershell.exe launch per cue
  per cue:          p50 282.8 ms · p95 304.8 ms · max 329.8 ms (20 runs)
```

The helper's per-cue time is the round trip of a command to PowerShell and back. It doesn't include Windows' own audio buffer, which every approach pays.

## Local development

```sh
npm install
npm run build
npm test
npm run sounds   # write every cue to assets/sounds/
```

Tests run on Linux, Windows and macOS in CI. Speakers aren't needed: the tests check what bellbird sends to the audio processes, and on Windows they also start the real PowerShell helper and talk to it.

## License

MIT
