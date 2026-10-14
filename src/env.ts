const off = new Set(["0", "off", "false", "no"]);
const on = new Set(["1", "on", "true", "yes"]);

// Whether sound should be on by default, from the environment:
// - BELLBIRD=0 (or off/false/no) turns every bellbird app silent.
// - BELLBIRD=1 (or on/true/yes) turns it on, even in CI.
// - In CI, where nobody is listening, it is off unless asked for.
export function soundAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.BELLBIRD?.trim().toLowerCase();

  if (setting !== undefined && off.has(setting)) {
    return false;
  }

  if (setting !== undefined && on.has(setting)) {
    return true;
  }

  const ci = env.CI?.trim().toLowerCase();

  return ci === undefined || ci === "" || ci === "0" || ci === "false";
}
