// Decides, from a finished Claude Code session, whether the attempt is a valid trial.
// Pure logic on the transcript lines (--output-format stream-json), so it can be unit-tested.
//
// Rules (decided before the first trial):
// - An attempt FAILS when the tool or the environment breaks, not the agent:
//     * an MCP server of the condition is not connected at start (the "init" event lists them);
//     * the dev server was not up at start, or was down at the end;
//     * the condition's tool was called and NOT ONE call succeeded (not installed, extension
//       not connected...). The tool is recognised by its signature (config/tools.json).
//       An agent that never calls its tool is not a failure: that is its behaviour.
//     * the session ended without a final "result" event (process killed, crash);
//     * the session ended with an error result other than the turn limit (e.g. the usage quota).
//   A failed attempt is not a trial: the launcher moves it aside and runs it again.
// - Code that does not build, or a page broken by the agent, is NOT a failure: the trial counts.
// - Hitting --max-turns is NOT a failure either: the trial counts, with a "max-turns" warning.
//   maxTurns is only a safety net, sized from the pilot.
// - The skill (decided 08/11): an attempt FAILS if the skill is not in the session's skill
//   list (the "init" event), or if the agent writes a file before loading the skill. Without
//   the skill the trial measures nothing. The launcher runs this check live and stops the
//   session at once, so almost no token is spent (createSkillGuard).
// - A forbidden use of the tool (decided 16/11, config/tools.json `forbidden`): e.g. Playwriter
//   started without its extension (`--browser headless`) is not the Playwriter condition.
//   The attempt FAILS, and the launcher stops the session live, as for the skill.
//   Since 17/11 the patterns are also read in the files the agent writes (Write, Edit, MultiEdit),
//   case-insensitively: the control of the Sonnet series launched Chrome from a script it wrote
//   first, then ran with `node`, a command that names no browser.

export type SessionVerdict = {
  valid: boolean;
  /** Why the attempt failed (empty when valid). */
  failures: string[];
  /** Things to read before trusting the numbers of a valid trial. */
  warnings: string[];
};

/** Parses the JSON lines of a stream-json transcript, ignoring a truncated or non-JSON line. */
export function parseTranscript(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* truncated line */ }
  }
  return events;
}

type ContentItem = { type?: string; id?: string; name?: string; input?: { command?: unknown; skill?: unknown; file_path?: unknown; content?: unknown; new_string?: unknown; edits?: unknown }; tool_use_id?: string; is_error?: boolean };

/** The text a tool call runs or writes: a Bash command, or the code written by Write, Edit or MultiEdit. */
function textOf(item: ContentItem): string | null {
  const i = item.input ?? {};
  if (item.name === "Bash") return typeof i.command === "string" ? i.command : null;
  if (item.name === "Write") return typeof i.content === "string" ? i.content : null;
  if (item.name === "Edit") return typeof i.new_string === "string" ? i.new_string : null;
  if (item.name === "MultiEdit" && Array.isArray(i.edits)) return i.edits.map((e: { new_string?: unknown }) => (typeof e.new_string === "string" ? e.new_string : "")).join("\n");
  return null;
}

/** Tools that write files: one of them before the skill is loaded means the agent works without it. */
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * Watches a session event by event (live, or over a finished transcript). Returns a failure
 * reason as soon as the agent cannot be following the skill, else null:
 * - the "init" event does not list the skill;
 * - a file-writing tool is called before the skill is loaded (the Skill tool with this name,
 *   or a Read of its SKILL.md).
 */
export function createSkillGuard(skillName: string): (event: Record<string, unknown>) => string | null {
  let loaded = false;
  return (event) => {
    if (event.type === "system" && event.subtype === "init") {
      const skills = Array.isArray(event.skills) ? (event.skills as unknown[]) : [];
      if (!skills.some((s) => s === skillName || (typeof s === "string" && s.endsWith(`:${skillName}`)))) {
        return `skill "${skillName}" not available in the session`;
      }
      return null;
    }
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) return null;
    for (const item of content as ContentItem[]) {
      if (item.type !== "tool_use") continue;
      const skill = item.input?.skill;
      const file = item.input?.file_path;
      if (item.name === "Skill" && typeof skill === "string" && (skill === skillName || skill.endsWith(`:${skillName}`))) loaded = true;
      else if (item.name === "Read" && typeof file === "string" && file.replace(/\\/g, "/").includes(`skills/${skillName}/SKILL.md`)) loaded = true;
      else if (!loaded && WRITE_TOOLS.includes(item.name ?? "")) return `agent wrote a file (${item.name}) before loading the skill`;
    }
    return null;
  };
}

/**
 * Watches a session event by event for a forbidden use of the tool (config/tools.json,
 * `forbidden`): a Bash command, or code written to a file, matching one of the patterns (case
 * ignored). Returns the reason at the first match, else null. Used live, so the session is
 * stopped before it spends more quota.
 */
export function createForbiddenGuard(forbidden: Array<{ pattern: string; reason: string }> = []): (event: Record<string, unknown>) => string | null {
  const rules = forbidden.map((f) => ({ re: new RegExp(f.pattern, "i"), reason: f.reason }));
  return (event) => {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (!rules.length || event.type !== "assistant" || !Array.isArray(content)) return null;
    for (const item of content as ContentItem[]) {
      const text = item.type === "tool_use" ? textOf(item) : null;
      if (text === null) continue;
      const hit = rules.find((r) => r.re.test(text));
      if (hit) return `forbidden use of the tool: ${hit.reason}`;
    }
    return null;
  };
}

/** The content items of the assistant and user messages of a transcript. */
function contentItems(events: Array<Record<string, unknown>>): ContentItem[] {
  return events.flatMap((e) => {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as ContentItem[]) : [];
  });
}

/** True if a Bash command runs one of the given command names (as a word, anywhere in the line). */
export function runsCommand(command: string, names: string[]): boolean {
  return names.some((n) => new RegExp(`(^|[\\s;&|(])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(command));
}

/** Calls of the condition's tool in the session, and how many of them succeeded. */
export function toolUsage(events: Array<Record<string, unknown>>, signature: { bash: string[]; tools: string[] }): { calls: number; succeeded: number } {
  const items = contentItems(events);
  const ids = new Set(
    items
      .filter((i) => i.type === "tool_use" && i.id && (
        signature.tools.some((p) => i.name?.startsWith(p)) ||
        (i.name === "Bash" && typeof i.input?.command === "string" && runsCommand(i.input.command, signature.bash))))
      .map((i) => i.id!),
  );
  const results = items.filter((i) => i.type === "tool_result" && i.tool_use_id && ids.has(i.tool_use_id));
  return { calls: ids.size, succeeded: results.filter((r) => r.is_error !== true).length };
}

/**
 * Classifies one attempt.
 * @param events          the transcript events, in order
 * @param expectedMcp     names of the MCP servers this condition plugs in
 * @param devServerUp     the dev server answered before the agent started AND after it ended
 * @param signature       how the condition's tool shows in the log (none for the control)
 * @param skillName       the skill the agent must load (no check if omitted)
 * @param forbidden       the tool's forbidden uses, from config/tools.json (none if omitted)
 */
export function checkSession(events: Array<Record<string, unknown>>, expectedMcp: string[], devServerUp: boolean,
  signature: { bash: string[]; tools: string[] } = { bash: [], tools: [] }, skillName?: string,
  forbidden: Array<{ pattern: string; reason: string }> = []): SessionVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!devServerUp) failures.push("dev server down");

  const forbiddenGuard = createForbiddenGuard(forbidden);
  for (const e of events) {
    const reason = forbiddenGuard(e);
    if (reason) { failures.push(reason); break; }
  }

  if (skillName) {
    const guard = createSkillGuard(skillName);
    for (const e of events) {
      const reason = guard(e);
      if (reason) { failures.push(reason); break; }
    }
  }

  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const servers = (init?.mcp_servers as Array<{ name: string; status: string }> | undefined) ?? [];
  for (const name of expectedMcp) {
    const s = servers.find((x) => x.name === name);
    if (!s) failures.push(`MCP server "${name}" missing from the session`);
    else if (s.status !== "connected") failures.push(`MCP server "${name}" ${s.status}`);
  }

  const usage = toolUsage(events, signature);
  if (usage.calls > 0 && usage.succeeded === 0) failures.push(`browser tool called ${usage.calls} times, never successfully`);

  // The agent can stop on its own when the plan's usage limit is near (18/11/2026: Playwright MCP
  // stopped at 3 sections of 6 and ended with "success"). Claude Code then flags the grace period,
  // or rejects a request, in its rate_limit_event: the trial is cut, whatever the result says.
  const limited = events.find((e) => {
    if (e.type !== "rate_limit_event") return false;
    const info = (e.rate_limit_info ?? {}) as { status?: string; rateLimitGraceActive?: boolean };
    return info.rateLimitGraceActive === true || info.status === "rejected";
  });
  if (limited) {
    const info = limited.rate_limit_info as { rateLimitType?: string };
    failures.push(`usage limit: the session hit your ${info.rateLimitType ?? "usage"} limit before the end`);
  }

  const result = [...events].reverse().find((e) => e.type === "result");
  if (!result) {
    failures.push("session ended without a result");
  } else if (result.subtype === "error_max_turns") {
    warnings.push("max-turns");
  } else if (result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error"))) {
    const detail = typeof result.result === "string" ? `: ${result.result.slice(0, 200)}` : "";
    failures.push(`session error (${String(result.subtype)})${detail}`);
  }

  return { valid: failures.length === 0, failures, warnings };
}

/**
 * True when a failed attempt was stopped by the plan's usage limit ("You've hit your 5-hour limit",
 * weekly limit...), not by the tool or the environment (18/11/2026). The launcher stops the run instead
 * of counting it: three such attempts in a row had declared two working tools unusable on 17/11.
 */
export function isUsageLimit(failures: string[]): boolean {
  return failures.some((f) => /hit your .*limit/i.test(f));
}
