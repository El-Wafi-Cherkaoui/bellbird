import { spawn as nodeSpawn } from "node:child_process";
import { sampleRate } from "../synth.js";
import type { ErrnoListener, ExitListener, Library, Output } from "./output.js";

// One long-lived audio process reads raw samples from its stdin. It connects
// to the sound server once, at start-up, so a cue costs only a short, steady
// buffer instead of launching a player each time (which is slow and varies
// from one launch to the next).
export type StreamProcess = {
  stdin: {
    write(chunk: Buffer): boolean;
    writableLength: number;
    destroyed: boolean;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  on(event: "error", listener: ErrnoListener): unknown;
  on(event: "exit", listener: ExitListener): unknown;
  unref(): void;
  kill(): unknown;
};

export type StreamSpawn = (command: string, args: string[]) => StreamProcess;

export type StreamBackend = { command: string; args: string[] };

export type StreamOutputOptions = {
  library: Library;
  backends: StreamBackend[];
  spawn?: StreamSpawn;
  now?: () => number;
};

// Audio is written in 20 ms chunks, kept about 60 ms ahead of playback. That
// small lead is the whole delay a cue has, and it never changes.
export const chunkSamples = Math.round(sampleRate * 0.02);
export const leadChunks = 3;
// A little silence after the last cue, so the sound server's buffer plays out its tail.
const tailChunks = 4;
const pumpIntervalMs = 10;
const fadeSamples = Math.round(sampleRate * 0.01);
const maxQueuedBytes = 64 * 1024;
const maxRestarts = 3;
// A backend that dies this soon after starting can't work here; try the next one.
const earlyExitMs = 1_500;

type Voice = { name: string; samples: Int16Array; position: number; fadeLeft: number | undefined };

export function createStreamOutput(options: StreamOutputOptions): Output {
  const spawn = options.spawn ?? defaultStreamSpawn;
  const now = options.now ?? Date.now;
  const voices: Voice[] = [];
  let child: StreamProcess | undefined;
  let backendIndex = 0;
  let restarts = 0;
  let failed = options.backends.length === 0;
  let closed = false;
  let spawnedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let burstStart = 0;
  let produced = 0;
  let tailLeft = 0;

  const giveUp = () => {
    failed = true;
    voices.length = 0;
    stopTimer();
  };

  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const open = () => {
    closed = false;

    // Render every cue now, so playing one never has to compute anything.
    for (const name of options.library.names()) {
      options.library.samples(name);
    }

    if (failed || child !== undefined) {
      return;
    }

    const backend = options.backends[backendIndex];

    if (backend === undefined) {
      giveUp();
      return;
    }

    let proc: StreamProcess;

    try {
      proc = spawn(backend.command, backend.args);
    } catch {
      giveUp();
      return;
    }

    child = proc;
    spawnedAt = now();
    proc.unref();
    proc.stdin?.on("error", () => {});
    proc.on("error", (error) => {
      if (child !== proc) {
        return;
      }

      child = undefined;

      if (error.code === "ENOENT") {
        // This player isn't installed; use the next one.
        backendIndex += 1;
        open();
      } else {
        retire();
      }
    });
    proc.on("exit", () => {
      if (child !== proc) {
        return;
      }

      child = undefined;

      if (!closed && now() - spawnedAt < earlyExitMs) {
        backendIndex += 1;
      }

      retire();
    });
  };

  // The stream ended on its own. Restart it, a few times at most.
  const retire = () => {
    stopTimer();
    voices.length = 0;

    if (closed) {
      return;
    }

    restarts += 1;

    if (restarts > maxRestarts) {
      giveUp();
      return;
    }

    open();
  };

  const mixChunk = (): Buffer => {
    const mix = new Int32Array(chunkSamples);

    for (const voice of voices) {
      for (let index = 0; index < chunkSamples && voice.position < voice.samples.length; index += 1) {
        let gain = 1;

        if (voice.fadeLeft !== undefined) {
          gain = Math.max(0, voice.fadeLeft) / fadeSamples;
          voice.fadeLeft -= 1;
        }

        mix[index]! += voice.samples[voice.position]! * gain;
        voice.position += 1;

        if (voice.fadeLeft !== undefined && voice.fadeLeft <= 0) {
          voice.position = voice.samples.length;
        }
      }
    }

    for (let index = voices.length - 1; index >= 0; index -= 1) {
      if (voices[index]!.position >= voices[index]!.samples.length) {
        voices.splice(index, 1);
      }
    }

    const chunk = Buffer.alloc(chunkSamples * 2);

    for (let index = 0; index < chunkSamples; index += 1) {
      chunk.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[index]!))), index * 2);
    }

    return chunk;
  };

  // Keeps the audio a fixed 60 ms ahead of the clock while anything is playing.
  const pump = () => {
    timer = undefined;

    const stdin = child?.stdin;

    if (stdin === null || stdin === undefined || stdin.destroyed) {
      voices.length = 0;
      return;
    }

    const target = ((now() - burstStart) / 1000) * sampleRate + leadChunks * chunkSamples;

    while (produced < target) {
      const chunk = mixChunk();

      produced += chunkSamples;

      // If the sound server stalls, drop audio rather than grow memory.
      if (stdin.writableLength < maxQueuedBytes) {
        stdin.write(chunk);
      }

      if (voices.length === 0) {
        tailLeft -= 1;

        if (tailLeft <= 0) {
          return;
        }
      } else {
        tailLeft = tailChunks;
      }
    }

    timer = setTimeout(pump, pumpIntervalMs);
    timer.unref();
  };

  const fadeAll = () => {
    for (const voice of voices) {
      voice.fadeLeft ??= fadeSamples;
    }
  };

  return {
    open,
    failed: () => failed,
    ready: () => Promise.resolve(),
    forget: () => {},
    playing: () => voices.map((voice) => voice.name),
    play(name, cut) {
      if (failed) {
        return;
      }

      if (child === undefined) {
        open();
      }

      if (failed) {
        return;
      }

      // An alert cuts what is playing, with a 10 ms fade so it doesn't click.
      if (cut) {
        fadeAll();
      }

      voices.push({ name, samples: options.library.samples(name), position: 0, fadeLeft: undefined });
      tailLeft = tailChunks;

      if (timer === undefined) {
        // Audio is idle, so playback starts with this write: restart the clock.
        burstStart = now();
        produced = 0;
        pump();
      }
    },
    stopAll: fadeAll,
    close() {
      closed = true;
      stopTimer();
      voices.length = 0;

      const current = child;

      child = undefined;

      try {
        current?.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

const defaultStreamSpawn: StreamSpawn = (command, args) => {
  const proc = nodeSpawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

  // Neither the player nor its pipe should keep the app alive after it quits.
  (proc.stdin as unknown as { unref?: () => void } | null)?.unref?.();

  return proc;
};

// Raw 16-bit mono at the cue sample rate. A small buffer keeps latency low.
// The first one that is installed and reaches a sound server wins.
export function streamBackends(platform: NodeJS.Platform, clientName = "bellbird"): StreamBackend[] {
  if (platform !== "linux") {
    return [];
  }

  return [
    { command: "pacat", args: ["--playback", `--rate=${sampleRate}`, "--format=s16le", "--channels=1", "--latency-msec=40", `--client-name=${clientName}`, `--stream-name=${clientName}`] },
    { command: "paplay", args: ["--raw", `--rate=${sampleRate}`, "--format=s16le", "--channels=1", "--latency-msec=40", `--client-name=${clientName}`] },
    { command: "pw-cat", args: ["--playback", "--rate", String(sampleRate), "--channels", "1", "--format", "s16", "--latency", "40ms", "-"] },
    { command: "aplay", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-B", "60000"] },
  ];
}
