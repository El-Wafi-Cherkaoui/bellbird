import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FileProcess, FileSpawn } from "./outputs/files.js";
import type { HelperProcess, HelperSpawn } from "./outputs/windows.js";
import type { StreamProcess, StreamSpawn } from "./outputs/stream.js";
import { bellbird, type BellbirdOptions } from "./player.js";

type Handlers = { error?: (error: NodeJS.ErrnoException) => void; exit?: (code: number | null) => void };

function fakeSpawn(behavior: (command: string, handlers: Handlers) => void = () => {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: FileProcess[] = [];
  const spawn: FileSpawn = (command, args) => {
    const handlers: Handlers = {};
    const child: FileProcess = {
      on(event: "error" | "exit", listener: never) {
        handlers[event] = listener;
        return child;
      },
      unref: vi.fn(),
      kill: vi.fn(() => {
        queueMicrotask(() => handlers.exit?.(null));
      }),
    };

    calls.push({ command, args });
    children.push(child);
    queueMicrotask(() => behavior(command, handlers));

    return child;
  };

  return { spawn, calls, children };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function setup(options: Partial<BellbirdOptions> & { spawn: FileSpawn }) {
  const directory = path.join(mkdtempSync(path.join(os.tmpdir(), "bellbird-")), "sounds");
  const player = bellbird({ enabled: true, directory, platform: "linux", streamBackends: [], ...options });

  return { directory, player };
}

// There is no built-in tick; apps define their own with kind "tick".
const tickSpec = { notes: [{ note: "E5", ms: 40 }], volume: 0.1, kind: "tick" as const };

const wavName = (call: { args: string[] }) => path.basename(call.args.at(-1)!).replace(/-[0-9a-f]{10}\.wav$/, "");

describe("bellbird with the per-cue file player", () => {
  it("writes the cue file and plays it with the platform player", () => {
    const { spawn, calls } = fakeSpawn();
    const { player, directory } = setup({ platform: "darwin", spawn });

    player.play("open");

    expect(calls[0]!.command).toBe("afplay");
    expect(wavName(calls[0]!)).toBe("open");
    expect(existsSync(calls[0]!.args[0]!)).toBe(true);
    expect(path.dirname(calls[0]!.args[0]!)).toBe(directory);
    expect(player.output()).toBe("files");
  });

  it("writes every cue file up front, so playing never waits on the disk", () => {
    const { spawn } = fakeSpawn();
    const { directory, player } = setup({ spawn });

    expect(readdirSync(directory)).toHaveLength(player.cues().length);
  });

  it("names files by their audio, so a redefined cue never plays a stale file", () => {
    const { spawn, calls } = fakeSpawn();
    let time = 1_000;
    const { player } = setup({ spawn, now: () => time });

    player.play("success");
    player.define("success", { notes: [{ note: "A5", ms: 200 }] });
    time += 1_000;
    player.play("success");

    expect(calls).toHaveLength(2);
    expect(wavName(calls[1]!)).toBe("success");
    expect(calls[1]!.args[0]).not.toBe(calls[0]!.args[0]);
  });

  it("plays nothing while disabled, and again once enabled", () => {
    const { spawn, calls } = fakeSpawn();
    const { player } = setup({ enabled: false, spawn });

    player.play("open");
    expect(calls).toHaveLength(0);
    expect(player.output()).toBe("none");

    player.setEnabled(true);
    player.play("open");
    expect(calls).toHaveLength(1);
  });

  it("is silent by default in CI and when BELLBIRD=0", () => {
    const { spawn, calls } = fakeSpawn();

    for (const env of [{ CI: "true" }, { BELLBIRD: "0" }]) {
      const player = bellbird({ env, directory: os.tmpdir(), platform: "linux", streamBackends: [], spawn });

      player.play("open");
      expect(player.isEnabled()).toBe(false);
    }

    expect(calls).toHaveLength(0);
  });

  it("throws for a cue that does not exist, listing the real ones", () => {
    const { spawn } = fakeSpawn();
    const { player } = setup({ spawn });

    expect(() => player.play("sucess")).toThrow(/Known cues: open, close/);
  });

  it("falls back to the next Linux player when one is missing", async () => {
    let time = 0;
    const { spawn, calls } = fakeSpawn((command, handlers) => {
      if (command === "paplay") {
        handlers.error?.(Object.assign(new Error("not found"), { code: "ENOENT" }));
      }
    });
    const { player } = setup({ spawn, now: () => time });

    player.play("open");
    await flush();
    time += 1_000;
    player.play("open");

    expect(calls.map((call) => call.command)).toEqual(["paplay", "pw-play"]);
  });

  it("goes quiet for good after repeated failures", async () => {
    let time = 0;
    const { spawn, calls } = fakeSpawn((_command, handlers) => handlers.exit?.(1));
    const { player } = setup({ spawn, now: () => time });

    for (let index = 0; index < 6; index += 1) {
      player.play("open");
      await flush();
      time += 1_000;
    }

    expect(calls).toHaveLength(3);
    expect(player.output()).toBe("none");
  });

  it("drops ticks that come too fast, but not slower ones", async () => {
    let time = 1_000;
    const { spawn, calls } = fakeSpawn((_command, handlers) => handlers.exit?.(0));
    const { player } = setup({ spawn, now: () => time });

    player.define("tick", tickSpec);

    player.play("tick");
    await flush();
    time += 20;
    player.play("tick");
    await flush();
    time += 100;
    player.play("tick");

    expect(calls).toHaveLength(2);
  });

  it("does not repeat the same cue within a moment", () => {
    let time = 1_000;
    const { spawn, calls } = fakeSpawn();
    const { player } = setup({ spawn, now: () => time });

    player.play("success");
    time += 30;
    player.play("success");

    expect(calls).toHaveLength(1);
  });

  it("does not play a tick while another sound is playing", () => {
    let time = 1_000;
    const { spawn, calls } = fakeSpawn();
    const { player } = setup({ spawn, now: () => time });

    player.define("tick", tickSpec);

    player.play("open");
    time += 200;
    player.play("tick");

    expect(calls).toHaveLength(1);
  });

  it("lets an alert cut what is playing, and never plays over an alert", async () => {
    let time = 1_000;
    let last: Handlers | undefined;
    const { spawn, calls, children } = fakeSpawn((_command, handlers) => {
      last = handlers;
    });
    const { player } = setup({ spawn, now: () => time });

    player.play("start");
    time += 150;
    player.play("attention");
    await flush();

    expect(children[0]!.kill).toHaveBeenCalledOnce();
    expect(wavName(calls[1]!)).toBe("attention");

    time += 200;
    player.play("success");
    expect(calls).toHaveLength(2);

    last?.exit?.(0);
    player.play("success");
    expect(calls).toHaveLength(3);
  });

  it("never throws when the cue file cannot be written", () => {
    const { spawn, calls } = fakeSpawn();
    // A folder inside a regular file can't be created on any platform.
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "bellbird-")), "plain-file");

    writeFileSync(file, "");

    const player = bellbird({ enabled: true, directory: path.join(file, "sounds"), platform: "linux", spawn, streamBackends: [] });

    expect(() => player.play("open")).not.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("bellbird with a long-lived output", () => {
  function fakeStream() {
    const writes: Buffer[] = [];
    const spawned: string[] = [];
    const spawn: StreamSpawn = (command) => {
      const child: StreamProcess = {
        stdin: { write: (chunk) => writes.push(chunk) > 0, writableLength: 0, destroyed: false, on: () => {} },
        on: () => child,
        unref: () => {},
        kill: () => {},
      };

      spawned.push(command);
      return child;
    };

    return { spawn, writes, spawned };
  }

  it("streams on Linux instead of launching a player per cue", () => {
    const stream = fakeStream();
    const files = vi.fn();
    const player = bellbird({ enabled: true, platform: "linux", streamBackends: [{ command: "pacat", args: [] }], streamSpawn: stream.spawn, spawn: files as never });

    player.play("open");

    expect(stream.spawned).toEqual(["pacat"]);
    expect(stream.writes.length).toBeGreaterThan(0);
    expect(files).not.toHaveBeenCalled();
    expect(player.output()).toBe("stream");
    player.close();
  });

  it("uses the PowerShell helper on Windows, and the file player if it can't start", async () => {
    const lines: string[] = [];
    let failStart: () => void = () => {};
    const helperSpawn: HelperSpawn = () => {
      const child: HelperProcess = {
        stdin: { write: (line) => lines.push(line) > 0, destroyed: false, on: () => {} },
        stdout: { on: () => {} },
        on(event: "error" | "exit", listener: never) {
          if (event === "error") {
            failStart = () => (listener as (error: NodeJS.ErrnoException) => void)(Object.assign(new Error("x"), { code: "ENOENT" }));
          }

          return child;
        },
        unref: () => {},
        kill: () => {},
      };

      return child;
    };
    const { spawn, calls } = fakeSpawn();
    const player = bellbird({ enabled: true, platform: "win32", helperSpawn, spawn, directory: mkdtempSync(path.join(os.tmpdir(), "bellbird-")) });

    expect(player.output()).toBe("helper");
    player.play("open");
    expect(lines.at(-1)).toBe("play open\n");

    failStart();
    await player.ready();

    expect(player.output()).toBe("files");
    player.play("success");
    expect(calls[0]!.command).toBe("powershell.exe");
  });
});

describe("playAndWait", () => {
  it("resolves after the cue has had time to finish", async () => {
    vi.useFakeTimers();

    const { spawn } = fakeSpawn();
    const { player } = setup({ spawn });
    let done = false;

    void player.playAndWait("success").then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
