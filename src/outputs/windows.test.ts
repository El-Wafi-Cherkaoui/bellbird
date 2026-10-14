import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWindowsOutput, helperCommand, helperScript, type HelperProcess, type HelperSpawn } from "./windows.js";

type Options = { answerPings?: boolean; failOn?: string };

function fakeHelper(options: Options = {}) {
  const lines: string[] = [];
  const spawned: Array<{ command: string; args: string[] }> = [];
  const kills: number[] = [];
  const exits: Array<(code: number | null) => void> = [];
  const errors: Array<(error: NodeJS.ErrnoException) => void> = [];
  let emit: (chunk: string) => void = () => {};

  const spawn: HelperSpawn = (command, args) => {
    const child: HelperProcess = {
      stdin: {
        write(chunk) {
          for (const line of chunk.split("\n").filter(Boolean)) {
            lines.push(line);

            if (line.startsWith("ping ") && options.answerPings !== false) {
              // Pongs can arrive split across chunks.
              const id = line.slice(5);

              queueMicrotask(() => {
                emit("po");
                emit(`ng ${id}\r\n`);
              });
            }

            if (options.failOn !== undefined && line.startsWith(options.failOn)) {
              queueMicrotask(() => emit(`fail ${options.failOn}\n`));
            }
          }

          return true;
        },
        destroyed: false,
        on: () => {},
      },
      stdout: {
        on(_event, listener) {
          emit = (chunk) => listener(chunk);
        },
      },
      on(event: "error" | "exit", listener: never) {
        (event === "exit" ? exits : errors).push(listener);
        return child;
      },
      unref: vi.fn(),
      kill: vi.fn(() => {
        kills.push(1);
      }),
    };

    spawned.push({ command, args });
    return child;
  };

  return { spawn, lines, spawned, kills, exit: (code: number) => exits.at(-1)?.(code), error: (code: string) => errors.at(-1)?.(Object.assign(new Error(code), { code })) };
}

const tone = (length: number, value = 1_000) => new Int16Array(length).fill(value);
const library = {
  names: () => ["open", "success", "attention"],
  samples: (name: string) => (name === "attention" ? tone(22_050) : tone(11_025)),
};
const commands = (lines: string[]) => lines.map((line) => line.split(" ")[0]);
const decodeWav = (base64: string) => {
  const wav = Buffer.from(base64, "base64");

  return Array.from({ length: (wav.length - 44) / 2 }, (_, index) => wav.readInt16LE(44 + index * 2));
};

let time = 0;

beforeEach(() => {
  vi.useFakeTimers();
  time = 10_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows helper output", () => {
  it("starts one hidden Windows PowerShell with the script encoded, not written to disk", () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    output.open();

    expect(helper.spawned).toHaveLength(1);
    expect(helper.spawned[0]!.command).toBe("powershell.exe");
    expect(helper.spawned[0]!.args).toContain("-EncodedCommand");
    expect(Buffer.from(helper.spawned[0]!.args.at(-1)!, "base64").toString("utf16le")).toBe(helperScript);
  });

  it("loads every cue up front, then checks the helper answers", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();

    // Loads, then silence to wake a sleeping sound card, then the check.
    expect(commands(helper.lines)).toEqual(["load", "load", "load", "mix", "ping"]);
    expect(decodeWav(helper.lines[3]!.split(" ")[1]!).every((value) => value === 0)).toBe(true);
    expect(helper.lines[0]!.startsWith("load open UklGR")).toBe(true);
  });

  it("plays an idle cue with one short line", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();
    output.play("success", false);

    expect(helper.lines.at(-1)).toBe("play success");
    expect(output.playing()).toEqual(["success"]);

    time += 600;
    expect(output.playing()).toEqual([]);
  });

  it("mixes overlapping cues into one sound, so neither is cut short", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();
    output.play("open", false);
    time += 250;
    output.play("success", false);

    const [command, data] = helper.lines.at(-1)!.split(" ");
    const mixed = decodeWav(data!);

    expect(command).toBe("mix");
    // Both are still sounding at the start of the mix, the rest is the new cue.
    expect(mixed[0]).toBe(2_000);
    expect(mixed[11_024]).toBe(1_000);
    // Then a little silence, so Windows doesn't drop the very end.
    expect(mixed.slice(11_025).every((value) => value === 0)).toBe(true);
    expect(mixed.length).toBeGreaterThan(11_025);
    expect(output.playing()).toEqual(["open", "success"]);
  });

  it("lets an alert fade out what is playing within 10 ms, without a click", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();
    output.play("open", false);
    time += 100;
    output.play("attention", true);

    const mixed = decodeWav(helper.lines.at(-1)!.split(" ")[1]!);
    // Only the cue itself: the test tone is flat, so it steps into the end padding.
    const cue = mixed.slice(0, 22_050);
    const steps = cue.slice(1).map((value, index) => Math.abs(value - cue[index]!));

    expect(mixed[0]).toBe(2_000);
    expect(mixed[300]).toBe(1_000);
    expect(Math.max(...steps)).toBeLessThan(10);
    expect(output.playing()).toEqual(["attention"]);
  });

  it("re-sends a cue that was redefined", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();
    output.forget("open");

    expect(helper.lines.at(-1)!.startsWith("load open ")).toBe(true);
  });

  it("gives up when PowerShell is missing, so the file player takes over", async () => {
    const helper = fakeHelper({ answerPings: false });
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    helper.error("ENOENT");
    await output.ready();

    expect(output.failed()).toBe(true);
  });

  it("gives up when PowerShell never answers", async () => {
    const helper = fakeHelper({ answerPings: false });
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time, startTimeoutMs: 5_000 });
    const ready = output.ready();

    await vi.advanceTimersByTimeAsync(5_000);
    await ready;

    expect(output.failed()).toBe(true);
    expect(helper.kills).toHaveLength(1);
  });

  it("gives up when PowerShell is locked down and every command fails", async () => {
    const helper = fakeHelper({ failOn: "load" });
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(output.failed()).toBe(true);
  });

  it("restarts after a later crash, a few times at most", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    for (let round = 0; round < 4; round += 1) {
      output.open();
      await output.ready();
      time += 10_000;
      helper.exit(1);
    }

    expect(helper.spawned).toHaveLength(4);
    expect(output.failed()).toBe(true);
  });

  it("measures a round trip once ready", async () => {
    vi.useRealTimers();

    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn });

    output.open();
    await output.ready();

    expect(await output.roundTrip()).toBeGreaterThanOrEqual(0);
  });

  it("stops the helper on close and does not restart it", async () => {
    const helper = fakeHelper();
    const output = createWindowsOutput({ library, spawn: helper.spawn, now: () => time });

    output.open();
    await output.ready();
    output.close();
    helper.exit(0);

    expect(helper.kills).toHaveLength(1);
    expect(helper.spawned).toHaveLength(1);
    expect(output.failed()).toBe(false);
  });
});

// The real thing, only where it can run.
describe.runIf(process.platform === "win32")("Windows helper on this machine", () => {
  it("parses as PowerShell", () => {
    const check = `$errors = $null; [System.Management.Automation.PSParser]::Tokenize([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${helperCommand.args.at(-1)}')), [ref]$errors) | Out-Null; $errors.Count`;

    expect(execFileSync("powershell.exe", ["-NoProfile", "-Command", check], { encoding: "utf8" }).trim()).toBe("0");
  });

  it("starts and answers", async () => {
    vi.useRealTimers();

    // Loading a sound needs no speakers, so this runs on CI machines too.
    const output = createWindowsOutput({ library: { names: () => ["tick"], samples: () => tone(2_000) } });

    output.open();
    await output.ready();

    expect(output.failed()).toBe(false);
    expect(await output.roundTrip()).toBeLessThan(1_000);
    output.close();
  }, 20_000);
});
