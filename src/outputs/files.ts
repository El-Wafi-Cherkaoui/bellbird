import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toWav } from "../synth.js";
import type { ErrnoListener, ExitListener, Library, Output } from "./output.js";

export type FileProcess = {
  on(event: "error", listener: ErrnoListener): unknown;
  on(event: "exit", listener: ExitListener): unknown;
  unref(): void;
  kill(): unknown;
};

export type FileSpawn = (command: string, args: string[]) => FileProcess;

export type FileOutputOptions = {
  library: Library;
  platform: NodeJS.Platform;
  // Folder for the generated WAV files. Default: <temp>/bellbird.
  directory?: string;
  spawn?: FileSpawn;
};

export type PlayerCommand = (file: string) => { command: string; args: string[] };

const maxFailures = 3;

export function defaultDirectory(): string {
  return path.join(os.tmpdir(), "bellbird");
}

// Plays each cue by starting the OS player on a small WAV file. Slower and
// less even than a long-lived process, so it is the fallback: macOS, or when
// the fast output could not start. It works almost everywhere.
export function createFileOutput(options: FileOutputOptions): Output {
  const spawn = options.spawn ?? defaultSpawn;
  const directory = options.directory ?? defaultDirectory();
  const candidates = playerCommands(options.platform);
  const files = new Map<string, string>();
  const active = new Set<{ name: string; child: FileProcess; killed: boolean }>();
  let candidateIndex = 0;
  let failures = 0;
  let broken = false;

  const stopAll = () => {
    for (const playing of active) {
      playing.killed = true;

      try {
        playing.child.kill();
      } catch {
        // Already gone.
      }
    }

    active.clear();
  };

  // The file name carries a hash of the audio, so a redefined cue (or a new
  // bellbird version) never plays a stale file left by an earlier run.
  const fileFor = (name: string): string | undefined => {
    const known = files.get(name);

    if (known !== undefined) {
      return known;
    }

    try {
      const wav = toWav(options.library.samples(name));
      const hash = createHash("sha1").update(wav).digest("hex").slice(0, 10);
      const file = path.join(directory, `${name}-${hash}.wav`);
      const temp = `${file}.${process.pid}.tmp`;

      mkdirSync(directory, { recursive: true });
      writeFileSync(temp, wav);
      renameSync(temp, file);
      files.set(name, file);

      return file;
    } catch {
      broken = true;
      return undefined;
    }
  };

  return {
    // Every cue file is written up front, so playing never waits on the disk.
    open() {
      for (const name of options.library.names()) {
        fileFor(name);
      }
    },
    ready: () => Promise.resolve(),
    forget: (name) => {
      files.delete(name);
    },
    stopAll,
    close: stopAll,
    failed: () => broken || candidateIndex >= candidates.length,
    playing: () => [...active].map((playing) => playing.name),
    play(name, cut) {
      const file = fileFor(name);
      const candidate = candidates[candidateIndex];

      if (broken || file === undefined || candidate === undefined) {
        return;
      }

      try {
        const { command, args } = candidate(file);

        if (cut) {
          stopAll();
        }

        const child = spawn(command, args);
        const entry = { name, child, killed: false };

        active.add(entry);
        child.unref();
        child.on("error", (error) => {
          active.delete(entry);

          if (error.code === "ENOENT") {
            // This player isn't installed; use the next one from now on.
            if (candidates[candidateIndex] === candidate) {
              candidateIndex += 1;
            }

            return;
          }

          failures += 1;
          broken ||= failures >= maxFailures;
        });
        child.on("exit", (code) => {
          active.delete(entry);

          if (entry.killed) {
            return;
          }

          if (code === 0) {
            failures = 0;
            return;
          }

          // No sound server (e.g. a headless machine): stop trying after a few misses.
          failures += 1;
          broken ||= failures >= maxFailures;
        });
      } catch {
        broken = true;
      }
    },
  };
}

export function playerCommands(platform: NodeJS.Platform): PlayerCommand[] {
  if (platform === "darwin") {
    return [(file) => ({ command: "afplay", args: [file] })];
  }

  if (platform === "win32") {
    return [
      (file) => ({
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync()`],
      }),
    ];
  }

  return [
    (file) => ({ command: "paplay", args: [file] }),
    (file) => ({ command: "pw-play", args: [file] }),
    (file) => ({ command: "aplay", args: ["-q", file] }),
  ];
}

const defaultSpawn: FileSpawn = (command, args) => nodeSpawn(command, args, { stdio: "ignore", windowsHide: true });
