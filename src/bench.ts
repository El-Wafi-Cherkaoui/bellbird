import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCueSet } from "./cues.js";
import { defaultDirectory, playerCommands } from "./outputs/files.js";
import { chunkSamples, leadChunks } from "./outputs/stream.js";
import { createWindowsOutput } from "./outputs/windows.js";
import { sampleRate, toWav } from "./synth.js";

export type BenchResult = {
  platform: NodeJS.Platform;
  fast: { name: string; startupMs?: number; latency: Stats | string } | undefined;
  perCue: { name: string; latency: Stats } | undefined;
};

export type Stats = { runs: number; p50: number; p95: number; max: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

  return { runs: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0 };
}

// Compares the long-lived output with starting a player for every cue, on
// this machine. You will hear a few soft sounds.
export async function bench(runs: number, platform: NodeJS.Platform = process.platform): Promise<BenchResult> {
  const library = createCueSet();
  const result: BenchResult = { platform, fast: undefined, perCue: undefined };

  if (platform === "win32") {
    const output = createWindowsOutput({ library });
    const started = performance.now();

    output.open();
    await output.ready();

    if (!output.failed()) {
      const startupMs = performance.now() - started;
      const trips: number[] = [];

      for (let run = 0; run < runs; run += 1) {
        output.play("open", false);

        const trip = await output.roundTrip();

        if (trip !== undefined) {
          trips.push(trip);
        }

        // Let each sound finish, so this measures the plain "play" path.
        await sleep(400);
      }

      result.fast = { name: "helper (PowerShell, kept open)", startupMs, latency: stats(trips) };
    }

    output.close();
  } else if (platform === "linux") {
    const leadMs = (leadChunks * chunkSamples * 1000) / sampleRate;

    result.fast = { name: "stream (pacat / pw-cat / aplay, kept open)", latency: `fixed: ${leadMs} ms lead + ~40 ms server buffer` };
  }

  // The usual approach: launch the OS player on a WAV file for each cue.
  // Overhead = how long the player ran, minus the length of the sound.
  const command = playerCommands(platform)[0];
  const directory = defaultDirectory();
  const file = path.join(directory, "bench-open.wav");
  const cue = library.get("open")!;

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, toWav(library.samples("open")));

  if (command !== undefined) {
    const overheads: number[] = [];

    for (let run = 0; run < runs; run += 1) {
      const { command: player, args } = command(file);
      const started = performance.now();
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(player, args, { stdio: "ignore", windowsHide: true });

        child.on("error", () => resolve(null));
        child.on("exit", resolve);
      });

      if (code !== 0) {
        break;
      }

      overheads.push(Math.max(0, performance.now() - started - cue.durationMs));
      await sleep(120);
    }

    if (overheads.length > 0) {
      result.perCue = { name: `one ${command(file).command} launch per cue`, latency: stats(overheads) };
    }
  }

  return result;
}
