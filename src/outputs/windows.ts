import { spawn as nodeSpawn } from "node:child_process";
import { mixSamples, sampleRate, toWav } from "../synth.js";
import type { ErrnoListener, ExitListener, Library, Output } from "./output.js";

// On Windows, starting a player for every cue costs a whole PowerShell
// launch (hundreds of ms, and uneven). Instead, one hidden PowerShell process
// is started once. Every cue is loaded into it as an in-memory sound up
// front, and playing a cue is then a single short line on its stdin.
//
// Windows' simple sound player plays one sound at a time, and a new sound
// cuts the old one. So when cues overlap, bellbird mixes the rest of what is
// playing with the new cue itself and sends the mix as one sound.
export type HelperProcess = {
  stdin: {
    write(chunk: string): boolean;
    destroyed: boolean;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  stdout: {
    setEncoding?(encoding: "utf8"): unknown;
    ref?(): unknown;
    unref?(): unknown;
    on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  } | null;
  on(event: "error", listener: ErrnoListener): unknown;
  on(event: "exit", listener: ExitListener): unknown;
  unref(): void;
  kill(): unknown;
};

export type HelperSpawn = (command: string, args: string[]) => HelperProcess;

export type WindowsOutputOptions = {
  library: Library;
  spawn?: HelperSpawn;
  now?: () => number;
  // How long PowerShell may take to start before bellbird gives up on it.
  startTimeoutMs?: number;
};

export type WindowsOutput = Output & {
  // Time for one command to reach the helper and come back, in ms.
  roundTrip(): Promise<number | undefined>;
};

const maxRestarts = 3;
const maxFailures = 3;
const earlyExitMs = 1_500;
const fadeSamples = Math.round(sampleRate * 0.01);
// Windows' simple player can drop the last few ms of an in-memory sound, so
// every sound gets a little silence at the end. It doesn't change when the
// next cue can start.
const tailPadSamples = Math.round(sampleRate * 0.06);
// Many sound cards power down their output when idle and lose the first
// ~100-200 ms of audio while waking up. Silence played at start-up wakes the
// device, so the app's first real cue isn't swallowed.
const warmUpSamples = Math.round(sampleRate * 0.3);

// A WAV ready to send to the helper: base64, padded with silence at the end.
export function helperWav(samples: Int16Array): string {
  const padded = new Int16Array(samples.length + tailPadSamples);

  padded.set(samples);

  return toWav(padded).toString("base64");
}

// Kept small and compatible with Windows PowerShell 5.1, which every Windows
// 10 and 11 machine has. Reads one command per line:
//   load <name> <base64 wav>   keep a sound in memory
//   play <name>                play a loaded sound (returns at once)
//   mix <base64 wav>           play a one-off sound (overlapping cues)
//   stop                       cut what is playing
//   ping <id>                  answer "pong <id>" (start-up check, benchmark)
export const helperScript = [
  "$ErrorActionPreference = 'Stop'",
  "$players = @{}",
  "$current = $null",
  "$in = [Console]::In",
  "$out = [Console]::Out",
  "function New-Sound([string]$data) {",
  "  $bytes = [Convert]::FromBase64String($data)",
  "  $player = New-Object System.Media.SoundPlayer (New-Object System.IO.MemoryStream (,$bytes))",
  "  $player.Load()",
  "  return $player",
  "}",
  "while ($true) {",
  "  $line = $in.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $space = $line.IndexOf(' ')",
  "  if ($space -lt 0) { $command = $line; $rest = '' } else { $command = $line.Substring(0, $space); $rest = $line.Substring($space + 1) }",
  "  try {",
  "    if ($command -eq 'load') {",
  "      $at = $rest.IndexOf(' ')",
  "      $players[$rest.Substring(0, $at)] = New-Sound $rest.Substring($at + 1)",
  "    } elseif ($command -eq 'play') {",
  "      $player = $players[$rest]",
  "      if ($null -ne $player) { $player.Play(); $current = $player }",
  "    } elseif ($command -eq 'mix') {",
  "      $current = New-Sound $rest",
  "      $current.Play()",
  "    } elseif ($command -eq 'stop') {",
  "      if ($null -ne $current) { $current.Stop() }",
  "    } elseif ($command -eq 'ping') {",
  "      $out.WriteLine('pong ' + $rest)",
  "      $out.Flush()",
  "    }",
  "  } catch {",
  "    $out.WriteLine('fail ' + $command)",
  "    $out.Flush()",
  "  }",
  "}",
].join("\n");

export const helperCommand = {
  command: "powershell.exe",
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(helperScript, "utf16le").toString("base64"),
  ],
};

type Voice = { names: string[]; samples: Int16Array; startedAt: number };

export function createWindowsOutput(options: WindowsOutputOptions): WindowsOutput {
  const spawn = options.spawn ?? defaultHelperSpawn;
  const now = options.now ?? Date.now;
  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  const pongs = new Map<number, () => void>();
  let child: HelperProcess | undefined;
  let voice: Voice | undefined;
  let failed = false;
  let closed = false;
  let isReady = false;
  let restarts = 0;
  let failures = 0;
  let spawnedAt = 0;
  let nextPing = 1;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let readyWaiters: Array<() => void> = [];

  const settleReady = () => {
    const waiters = readyWaiters;

    readyWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  };

  const giveUp = () => {
    failed = true;
    voice = undefined;
    clearStartTimer();
    settleReady();

    const waiting = [...pongs.values()];

    pongs.clear();
    holdOpen();

    for (const resolve of waiting) {
      resolve();
    }

    const current = child;

    child = undefined;

    try {
      current?.kill();
    } catch {
      // Already gone.
    }
  };

  const clearStartTimer = () => {
    if (startTimer !== undefined) {
      clearTimeout(startTimer);
      startTimer = undefined;
    }
  };

  const send = (line: string) => {
    const stdin = child?.stdin;

    if (stdin === null || stdin === undefined || stdin.destroyed) {
      return;
    }

    stdin.write(`${line}\n`);
  };

  const load = (name: string) => {
    send(`load ${name} ${helperWav(options.library.samples(name))}`);
  };

  // The helper's pipes don't keep the app alive, except while bellbird is
  // waiting for an answer from it.
  const holdOpen = () => {
    if (pongs.size > 0) {
      child?.stdout?.ref?.();
    } else {
      child?.stdout?.unref?.();
    }
  };

  const ping = (): Promise<void> => new Promise((resolve) => {
    const id = nextPing;

    nextPing += 1;
    pongs.set(id, resolve);
    holdOpen();
    send(`ping ${id}`);
  });

  const onLine = (line: string) => {
    const space = line.indexOf(" ");
    const kind = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space + 1);

    if (kind === "pong") {
      const id = Number(rest);

      const resolve = pongs.get(id);

      pongs.delete(id);
      holdOpen();
      resolve?.();
    } else if (kind === "fail") {
      // PowerShell is locked down here, or a sound would not load.
      failures += 1;

      if (failures >= maxFailures) {
        giveUp();
      }
    }
  };

  const open = () => {
    closed = false;

    if (failed || child !== undefined) {
      return;
    }

    let proc: HelperProcess;

    try {
      proc = spawn(helperCommand.command, helperCommand.args);
    } catch {
      giveUp();
      return;
    }

    child = proc;
    isReady = false;
    spawnedAt = now();
    proc.unref();
    proc.stdin?.on("error", () => {});

    let pending = "";

    proc.stdout?.setEncoding?.("utf8");
    proc.stdout?.on("data", (chunk) => {
      pending += chunk.toString();

      let newline = pending.indexOf("\n");

      while (newline >= 0) {
        onLine(pending.slice(0, newline).trim());
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    proc.on("error", () => {
      if (child === proc) {
        // No PowerShell (ENOENT) or it can't start: the file player takes over.
        giveUp();
      }
    });
    proc.on("exit", () => {
      if (child !== proc) {
        return;
      }

      child = undefined;
      voice = undefined;

      if (closed) {
        return;
      }

      restarts += 1;

      if (!isReady || now() - spawnedAt < earlyExitMs || restarts > maxRestarts) {
        giveUp();
        return;
      }

      open();
    });

    // Sounds are loaded first; the stdin pipe keeps their order, so a cue
    // played before PowerShell is up still plays once it is.
    for (const name of options.library.names()) {
      load(name);
    }

    // Not tracked as a voice: the first real cue simply replaces it.
    send(`mix ${helperWav(new Int16Array(warmUpSamples))}`);

    startTimer = setTimeout(giveUp, startTimeoutMs);
    startTimer.unref?.();

    void ping().then(() => {
      if (child !== proc) {
        return;
      }

      clearStartTimer();
      isReady = true;
      settleReady();
    });
  };

  const current = (): Voice | undefined => {
    if (voice !== undefined && now() - voice.startedAt >= (voice.samples.length / sampleRate) * 1000) {
      voice = undefined;
    }

    return voice;
  };

  // What is still left to play of the current sound, from this moment.
  const remainder = (playing: Voice, fade: boolean): Int16Array => {
    const elapsed = Math.floor(((now() - playing.startedAt) / 1000) * sampleRate);
    const rest = playing.samples.slice(Math.min(elapsed, playing.samples.length));

    if (fade) {
      const length = Math.min(rest.length, fadeSamples);

      for (let index = 0; index < rest.length; index += 1) {
        rest[index] = index < length ? Math.round(rest[index]! * (1 - index / length)) : 0;
      }

      return rest.subarray(0, length);
    }

    return rest;
  };

  return {
    open,
    failed: () => failed,
    ready() {
      if (failed || isReady) {
        return Promise.resolve();
      }

      open();

      return failed ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve));
    },
    async roundTrip() {
      if (!isReady || failed) {
        return undefined;
      }

      const started = performance.now();

      await ping();

      return failed ? undefined : performance.now() - started;
    },
    forget(name) {
      if (child !== undefined) {
        load(name);
      }
    },
    playing: () => current()?.names ?? [],
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

      const samples = options.library.samples(name);
      const playing = current();

      if (playing === undefined) {
        send(`play ${name}`);
        voice = { names: [name], samples, startedAt: now() };
        return;
      }

      // Something is still sounding. Play it and the new cue together as one
      // sound, so neither is cut short (an alert fades the old one out instead).
      const mixed = mixSamples([
        { samples: remainder(playing, cut), offset: 0 },
        { samples, offset: 0 },
      ]);

      send(`mix ${helperWav(mixed)}`);
      voice = { names: cut ? [name] : [...playing.names, name], samples: mixed, startedAt: now() };
    },
    stopAll() {
      if (voice !== undefined) {
        send("stop");
        voice = undefined;
      }
    },
    close() {
      closed = true;
      voice = undefined;
      clearStartTimer();

      const proc = child;

      child = undefined;

      try {
        proc?.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

const defaultHelperSpawn: HelperSpawn = (command, args) => {
  const proc = nodeSpawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

  // The helper must never keep the app alive after it is done.
  (proc.stdin as unknown as { unref?: () => void } | null)?.unref?.();

  return proc;
};
