import { describe, expect, it } from "vitest";
import { parseWrap, quoteForCmd } from "./cli-args.js";
import { soundAllowed } from "./env.js";

describe("soundAllowed", () => {
  it("is on by default", () => {
    expect(soundAllowed({})).toBe(true);
  });

  it("is off when BELLBIRD says so", () => {
    for (const value of ["0", "off", "false", "No"]) {
      expect(soundAllowed({ BELLBIRD: value })).toBe(false);
    }
  });

  it("is off in CI, unless BELLBIRD turns it on", () => {
    expect(soundAllowed({ CI: "true" })).toBe(false);
    expect(soundAllowed({ CI: "1" })).toBe(false);
    expect(soundAllowed({ CI: "false" })).toBe(true);
    expect(soundAllowed({ CI: "true", BELLBIRD: "1" })).toBe(true);
  });
});

describe("parseWrap", () => {
  it("reads options before -- and the command after it", () => {
    expect(parseWrap(["--min", "10", "--error", "attention", "--", "npm", "run", "build"])).toEqual({
      min: 10,
      success: "success",
      error: "attention",
      command: ["npm", "run", "build"],
    });
  });

  it("accepts a command without --", () => {
    expect(parseWrap(["make", "-j4"]).command).toEqual(["make", "-j4"]);
  });

  it("keeps the command's own flags", () => {
    expect(parseWrap(["--", "ls", "--min"]).command).toEqual(["ls", "--min"]);
  });

  it("explains a missing command or a bad option", () => {
    expect(() => parseWrap(["--"])).toThrow(/needs a command/);
    expect(() => parseWrap(["--loud", "--", "ls"])).toThrow(/--loud/);
    expect(() => parseWrap(["--min"])).toThrow(/--min/);
  });
});

describe("quoteForCmd", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(quoteForCmd("run")).toBe("run");
    expect(quoteForCmd("C:\\x\\y.txt")).toBe("C:\\x\\y.txt");
    expect(quoteForCmd("two words")).toBe('"two words"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });
});
