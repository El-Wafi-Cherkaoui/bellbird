# Changelog

## 0.1.1 (2026-10-14)

- README: how to use bellbird in your own project, with recipes for a one-shot script and a long-running app, and notes on reusing one player, CommonJS and TypeScript.

## 0.1.0 (2026-10-14)

First release, extracted from Sable's sound module.

- Seven built-in cues on one pentatonic scale: open, close, start, stop, success, error, attention.
- `define()` for your own cues, with note names or frequencies.
- Linux: one long-lived audio stream with a fixed, short delay.
- Windows: one long-lived PowerShell helper with cues preloaded in memory; overlapping cues are mixed in Node.
- Every platform falls back to one player launch per cue, then to silence. Sound problems never throw.
- `BELLBIRD=0` turns sound off; it is off in CI unless `BELLBIRD=1`.
- CLI: play a cue, `list`, `demo`, `wrap` a command, `bench`.
