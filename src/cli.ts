#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { bench, type Stats } from "./bench.js";
import { parseWrap, quoteForCmd } from "./cli-args.js";
import { bellbird } from "./player.js";

const help = `bellbird — soft sound cues for the terminal

Usage:
  bellbird <cue>                    play a cue (success, error, attention, ...)
  bellbird list                     list the built-in cues
  bellbird demo                     play every cue, one after another
  bellbird wrap [options] -- <cmd>  run a command, then chime: success or error
      --min <seconds>               only chime if it took at least this long
      --success <cue>               cue for exit code 0 (default: success)
      --error <cue>                 cue for any other exit code (default: error)
  bellbird bench [--runs <n>]       measure sound delay on this machine

Sound is off when BELLBIRD=0, and in CI unless BELLBIRD=1.
`;

function runCommand(command: string[]): Promise<number> {
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(command.map(quoteForCmd).join(" "), { stdio: "inherit", shell: true })
    : spawn(command[0]!, command.slice(1), { stdio: "inherit" });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`bellbird: could not run ${command[0]}: ${error.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal))));
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[signal as string] ?? 1;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

  return pkg.version;
}

const format = (latency: Stats | string) => typeof latency === "string"
  ? latency
  : `p50 ${latency.p50.toFixed(1)} ms · p95 ${latency.p95.toFixed(1)} ms · max ${latency.max.toFixed(1)} ms (${latency.runs} runs)`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(help);
    return 0;
  }

  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (command === "bench") {
    const runsAt = rest.indexOf("--runs");
    const runs = runsAt >= 0 ? Math.max(1, Math.min(200, Number(rest[runsAt + 1]) || 20)) : 20;

    process.stdout.write(`Measuring on ${process.platform} (${runs} runs each). You will hear soft sounds.\n\n`);

    const result = await bench(runs);

    if (result.fast !== undefined) {
      process.stdout.write(`bellbird ${result.fast.name}\n`);

      if (result.fast.startupMs !== undefined) {
        process.stdout.write(`  start-up, once:   ${result.fast.startupMs.toFixed(0)} ms\n`);
      }

      process.stdout.write(`  per cue:          ${format(result.fast.latency)}\n\n`);
    } else {
      process.stdout.write("No low-latency output on this platform yet; bellbird uses the per-cue player.\n\n");
    }

    if (result.perCue !== undefined) {
      process.stdout.write(`Baseline: ${result.perCue.name}\n  per cue:          ${format(result.perCue.latency)}\n`);
    } else {
      process.stdout.write("Baseline: no working audio player found.\n");
    }

    if (process.platform === "win32") {
      process.stdout.write("\nHelper per-cue time is a full round trip to PowerShell and back; the one-way delay is about half.\n");
    }

    return 0;
  }

  const player = bellbird({ appName: "bellbird" });

  try {
    if (command === "list") {
      process.stdout.write(`${player.cues().join("\n")}\n`);
      return 0;
    }

    if (command === "demo") {
      if (!player.isEnabled()) {
        process.stderr.write("bellbird: sound is off (BELLBIRD=0, or running in CI).\n");
        return 0;
      }

      for (const name of player.cues()) {
        process.stdout.write(`${name}\n`);
        await player.playAndWait(name);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      return 0;
    }

    if (command === "wrap") {
      const options = parseWrap(rest);

      for (const name of [options.success, options.error]) {
        if (!player.cues().includes(name)) {
          throw new Error(`there is no cue named "${name}"`);
        }
      }

      // Start the sound helper now, so the chime is instant when the command ends.
      void player.ready();

      const started = Date.now();
      const code = await runCommand(options.command);

      if ((Date.now() - started) / 1000 >= options.min) {
        await player.playAndWait(code === 0 ? options.success : options.error);
      }

      return code;
    }

    const name = command === "play" ? rest[0] : command;

    if (name === undefined || !player.cues().includes(name)) {
      process.stderr.write(`bellbird: unknown cue or command "${name ?? ""}". Try: bellbird list\n`);
      return 2;
    }

    await player.playAndWait(name);
    return 0;
  } catch (error) {
    process.stderr.write(`bellbird: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    player.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
