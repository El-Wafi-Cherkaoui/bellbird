import { createCueSet, type CueSpec } from "./cues.js";
import { soundAllowed } from "./env.js";
import { createFileOutput, type FileSpawn } from "./outputs/files.js";
import type { Output } from "./outputs/output.js";
import { createStreamOutput, streamBackends, type StreamBackend, type StreamSpawn } from "./outputs/stream.js";
import { createWindowsOutput, type HelperSpawn, type WindowsOutput } from "./outputs/windows.js";

export type BellbirdOptions = {
  // Start with sound on or off. Default: on, unless BELLBIRD=0 or running in CI.
  enabled?: boolean;
  // Folder for the WAV files used by the fallback player. Default: <temp>/bellbird.
  directory?: string;
  // Name shown in the system's volume mixer, where supported (Linux).
  appName?: string;
  // For tests: pretend to be another platform, or replace processes and the clock.
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: FileSpawn;
  streamSpawn?: StreamSpawn;
  streamBackends?: StreamBackend[];
  helperSpawn?: HelperSpawn;
  now?: () => number;
};

export type OutputKind = "stream" | "helper" | "files" | "none";

export type Bellbird = {
  // Plays a cue and returns at once. Never throws for audio problems: when
  // sound can't work here, nothing plays.
  play(name: string): void;
  // Plays a cue and resolves when it has finished. Handy before exiting.
  playAndWait(name: string): Promise<void>;
  // Adds a cue, or replaces one (built-ins included).
  define(name: string, spec: CueSpec): void;
  // The names of every cue this player knows.
  cues(): string[];
  // Resolves once cues play without a start-up delay.
  ready(): Promise<void>;
  // Which way sound is coming out right now.
  output(): OutputKind;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  // Stops all sound and the helper process. Call it when your app exits.
  close(): void;
};

// Cues closer together than this are merged into one, so holding a key
// doesn't turn into a buzz.
const tickGapMs = 60;
const repeatGapMs = 100;
// The OS audio buffer, so playAndWait doesn't cut the end of a cue.
// Windows' simple player buffers more than Linux sound servers do.
const drainMs = 150;
const helperDrainMs = 350;

export function bellbird(options: BellbirdOptions = {}): Bellbird {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const library = createCueSet();
  const files = createFileOutput({ library, platform, directory: options.directory, spawn: options.spawn });
  const fast = fastOutput(platform, library, options, now);
  const lastPlayed = new Map<string, number>();
  let lastAnyAt = Number.NEGATIVE_INFINITY;
  let enabled = options.enabled ?? soundAllowed(options.env);

  const output = (): Output | undefined => {
    if (fast !== undefined && !fast.output.failed()) {
      return fast.output;
    }

    return files.failed() ? undefined : files;
  };

  const start = () => {
    if (fast !== undefined && !fast.output.failed()) {
      fast.output.open();
    } else {
      files.open();
    }
  };

  const ready = async () => {
    if (!enabled || fast === undefined) {
      return;
    }

    await fast.output.ready();

    if (fast.output.failed()) {
      files.open();
    }
  };

  if (enabled) {
    start();
  }

  const play = (name: string) => {
    const cue = library.get(name);

    if (cue === undefined) {
      throw new RangeError(`bellbird: there is no cue named "${name}". Known cues: ${library.names().join(", ")}.`);
    }

    if (!enabled) {
      return;
    }

    const out = output();

    if (out === undefined) {
      return;
    }

    const at = now();
    const playing = out.playing();

    // An alert always finishes, and a tick never plays over another sound.
    if (cue.kind !== "alert" && playing.some((other) => library.get(other)?.kind === "alert")) {
      return;
    }

    if (cue.kind === "tick" && (at - lastAnyAt < tickGapMs || playing.length > 0)) {
      return;
    }

    if (at - (lastPlayed.get(name) ?? Number.NEGATIVE_INFINITY) < repeatGapMs) {
      return;
    }

    lastPlayed.set(name, at);
    lastAnyAt = at;
    out.play(name, cue.kind === "alert");
  };

  return {
    play,
    ready,
    async playAndWait(name) {
      await ready();
      play(name);

      if (enabled) {
        const drain = output() === fast?.output && fast?.kind === "helper" ? helperDrainMs : drainMs;

        await new Promise((resolve) => setTimeout(resolve, library.get(name)!.durationMs + drain));
      }
    },
    define(name, spec) {
      library.define(name, spec);
      fast?.output.forget(name);
      files.forget(name);
    },
    cues: () => library.names(),
    output() {
      if (!enabled) {
        return "none";
      }

      const out = output();

      return out === undefined ? "none" : out === files ? "files" : fast!.kind;
    },
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;

      if (next) {
        start();
      } else {
        fast?.output.close();
        files.stopAll();
      }
    },
    close() {
      fast?.output.close();
      files.close();
    },
  };
}

// The low-latency output for this platform, if it has one.
function fastOutput(
  platform: NodeJS.Platform,
  library: ReturnType<typeof createCueSet>,
  options: BellbirdOptions,
  now: () => number,
): { kind: "stream"; output: Output } | { kind: "helper"; output: WindowsOutput } | undefined {
  if (platform === "win32") {
    return { kind: "helper", output: createWindowsOutput({ library, spawn: options.helperSpawn, now }) };
  }

  const backends = options.streamBackends ?? streamBackends(platform, options.appName);

  if (backends.length === 0) {
    return undefined;
  }

  return { kind: "stream", output: createStreamOutput({ library, backends, spawn: options.streamSpawn, now }) };
}
