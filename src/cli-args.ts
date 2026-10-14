export type WrapArgs = { min: number; success: string; error: string; command: string[] };

export function parseWrap(args: string[]): WrapArgs {
  const parsed: WrapArgs = { min: 0, success: "success", error: "error", command: [] };
  let index = 0;

  for (; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--") {
      index += 1;
      break;
    }

    const value = args[index + 1];

    if (arg === "--min" && value !== undefined && Number(value) >= 0) {
      parsed.min = Number(value);
    } else if (arg === "--success" && value !== undefined) {
      parsed.success = value;
    } else if (arg === "--error" && value !== undefined) {
      parsed.error = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown or incomplete option "${arg}"`);
    } else {
      // No "--": the command starts here.
      break;
    }

    index += 1;
  }

  parsed.command = args.slice(index);

  if (parsed.command.length === 0) {
    throw new Error("wrap needs a command, e.g. bellbird wrap -- npm test");
  }

  return parsed;
}

// On Windows, commands like npm are .cmd scripts, which only run through the shell.
export function quoteForCmd(arg: string): string {
  return /^[\w\-.:/\\=@]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`;
}
