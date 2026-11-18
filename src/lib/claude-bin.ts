// Finds the Claude Code executable and reads its login status, so the bench works on any
// machine without touching the PATH.
//
// Search order (the first one set wins; an explicit setting that points nowhere is an error,
// never silently skipped):
//   1. the CLAUDE_BIN environment variable (to force a path for one run);
//   2. claudeBin in config/bench.local.json (a machine setting, kept out of git);
//   3. the PATH;
//   4. the native installer's default location: ~/.local/bin/claude (claude.exe on Windows),
//      per https://code.claude.com/docs/en/setup
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeBinSource = "CLAUDE_BIN" | "claudeBin" | "PATH" | "default location";
export type ClaudeBin = { path: string; source: ClaudeBinSource };

type Inputs = {
  env?: NodeJS.ProcessEnv;
  configured?: string | null;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (p: string) => boolean;
};

/** Looks for `name` in every PATH folder, with the Windows extensions (PATHEXT) on Windows. */
function searchPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const join = win ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves the Claude Code executable. Returns it with where it was found, or throws with
 * every place looked at and how to fix it.
 */
export function resolveClaudeBin(inputs: Inputs = {}): ClaudeBin {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? os.homedir();
  const exists = inputs.exists ?? existsSync;
  const win = platform === "win32";

  const explicit: [ClaudeBinSource, string | null | undefined][] = [["CLAUDE_BIN", env.CLAUDE_BIN], ["claudeBin", inputs.configured]];
  for (const [source, value] of explicit) {
    if (!value) continue;
    if (!exists(value)) throw new Error(`${source} is set to "${value}", but there is no file there. Fix or remove it.`);
    return checkShim({ path: value, source });
  }

  const onPath = searchPath("claude", env, platform, exists);
  if (onPath) return checkShim({ path: onPath, source: "PATH" });

  const fallback = (win ? path.win32.join : path.posix.join)(home, ".local", "bin", win ? "claude.exe" : "claude");
  if (exists(fallback)) return { path: fallback, source: "default location" };

  throw new Error([
    "Claude Code not found. Looked at: CLAUDE_BIN (not set), claudeBin in config/bench.local.json (not set), the PATH, " + fallback + ".",
    "Install it (https://code.claude.com/docs/en/setup), or put its path in config/bench.local.json: { \"claudeBin\": \"<path>\" }.",
  ].join("\n"));
}

/**
 * A .cmd or .bat file (e.g. the shim of an npm install on Windows) can only start through a
 * shell, which would mangle the prompt's quotes. Ask for the real executable instead.
 */
function checkShim(bin: ClaudeBin): ClaudeBin {
  if (/\.(cmd|bat)$/i.test(bin.path)) {
    throw new Error(`${bin.source} gives "${bin.path}", a script shim the bench cannot start safely. Put the path of claude.exe in config/bench.local.json: { "claudeBin": "<path>" }.`);
  }
  return bin;
}

/** What `claude auth status` prints (JSON), the fields the bench reads. */
export type AuthStatus = { loggedIn?: boolean; authMethod?: string };

/**
 * Checks the output of `claude auth status` (free: no model call, per
 * https://code.claude.com/docs/en/cli-reference). Returns null if the bench can run, else why not.
 * An API key is refused: in print mode (-p) Claude Code always uses it when present, and the
 * trials would be billed at API rates instead of using the subscription
 * (https://code.claude.com/docs/en/authentication).
 */
export function checkAuth(exitCode: number | null, stdout: string): string | null {
  let status: AuthStatus;
  try {
    status = JSON.parse(stdout) as AuthStatus;
  } catch {
    return `"claude auth status" did not print JSON (exit code ${exitCode}). Is this Claude Code version recent enough?`;
  }
  if (exitCode !== 0 || !status.loggedIn) return "Claude Code is not logged in. Run `claude` once and log in with your plan (or `claude auth login`).";
  if (status.authMethod === "api_key" || status.authMethod === "api_key_helper") {
    return `Claude Code would use an API key (authMethod "${status.authMethod}"): the trials would be billed at API rates, not on your plan. Unset ANTHROPIC_API_KEY (or the key helper) and log in with your plan.`;
  }
  return null;
}
