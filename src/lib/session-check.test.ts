// Unit tests of session-check.ts: run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSession, createForbiddenGuard, createSkillGuard, isUsageLimit, parseTranscript, runsCommand } from "./session-check.ts";

const SKILL = "frontend-feedback-loop";
const withSkills = (skills: string[]) => ({ type: "system", subtype: "init", skills, mcp_servers: [] });
const use = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input }] } });
const guardRun = (events: Array<Record<string, unknown>>) => {
  const guard = createSkillGuard(SKILL);
  for (const e of events) { const r = guard(e); if (r) return r; }
  return null;
};

test("skill guard: loading the skill, then writing, is fine", () => {
  assert.equal(guardRun([withSkills([SKILL]), use("Read", { file_path: "mockup/design.json" }), use("Skill", { skill: SKILL }), use("Write", { file_path: "src/App.tsx" })]), null);
});

test("skill guard: reading its SKILL.md counts as loading it", () => {
  assert.equal(guardRun([withSkills([SKILL]), use("Read", { file_path: "C:\\w\\.claude\\skills\\frontend-feedback-loop\\SKILL.md" }), use("Edit", { file_path: "a" })]), null);
});

test("skill guard: a skill missing from the session stops it at once", () => {
  assert.match(guardRun([withSkills(["other"])])!, /not available/);
});

test("skill guard: writing before loading the skill stops the session", () => {
  assert.match(guardRun([withSkills([SKILL]), use("Write", { file_path: "src/App.tsx" })])!, /before loading the skill/);
});

test("checkSession fails an attempt that ignored the skill", () => {
  const events = [withSkills([SKILL]), use("Edit", { file_path: "a" }), { type: "result", subtype: "success" }];
  assert.equal(checkSession(events, [], true, undefined, SKILL).valid, false);
});

const init = (status = "connected") => ({ type: "system", subtype: "init", mcp_servers: [{ name: "playwright", status }] });
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 120 };

test("a normal session is a valid trial", () => {
  const v = checkSession([init(), ok], ["playwright"], true);
  assert.deepEqual(v, { valid: true, failures: [], warnings: [] });
});

test("the control has no MCP server to check", () => {
  assert.equal(checkSession([{ type: "system", subtype: "init", mcp_servers: [] }, ok], [], true).valid, true);
});

test("an MCP server that did not connect fails the attempt", () => {
  const v = checkSession([init("failed"), ok], ["playwright"], true);
  assert.equal(v.valid, false);
  assert.match(v.failures[0], /playwright.*failed/);
});

test("a dev server down fails the attempt", () => {
  assert.equal(checkSession([init(), ok], ["playwright"], false).valid, false);
});

test("a session cut without a result fails the attempt", () => {
  assert.deepEqual(checkSession([init()], ["playwright"], true).failures, ["session ended without a result"]);
});

test("an error result (e.g. usage quota) fails the attempt", () => {
  const v = checkSession([init(), { type: "result", subtype: "error_during_execution", is_error: true }], ["playwright"], true);
  assert.equal(v.valid, false);
});

test("the turn limit is a warning, not a failure", () => {
  const v = checkSession([init(), { type: "result", subtype: "error_max_turns", is_error: true }], ["playwright"], true);
  assert.deepEqual(v, { valid: true, failures: [], warnings: ["max-turns"] });
});

// Minimal assistant/user events carrying one tool call and its result.
const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const answer = (id: string, isError: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });
const cli = { bash: ["agent-browser"], tools: [] };
const chrome = { bash: [], tools: ["mcp__claude-in-chrome__"] };
const noMcp = { type: "system", subtype: "init", mcp_servers: [] };

test("a CLI tool that never succeeds fails the attempt", () => {
  const events = [noMcp, call("a", "Bash", { command: "agent-browser open http://localhost:5173" }), answer("a", true), ok];
  const v = checkSession(events, [], true, cli);
  assert.equal(v.valid, false);
  assert.match(v.failures[0], /never successfully/);
});

test("one successful call is enough, even after errors", () => {
  const events = [noMcp, call("a", "Bash", { command: "cd x && agent-browser open u" }), answer("a", true),
    call("b", "Bash", { command: "agent-browser snapshot" }), answer("b", false), ok];
  assert.equal(checkSession(events, [], true, cli).valid, true);
});

test("an extension tool that never connects fails the attempt", () => {
  const events = [noMcp, call("a", "mcp__claude-in-chrome__navigate"), answer("a", true), ok];
  assert.equal(checkSession(events, [], true, chrome).valid, false);
});

test("an agent that never calls its tool is not a failure", () => {
  const events = [noMcp, call("a", "Bash", { command: "npm run build" }), answer("a", true), ok];
  assert.equal(checkSession(events, [], true, cli).valid, true);
});

test("a command name is matched as a word only", () => {
  assert.equal(runsCommand("npx agent-browser-helper", ["agent-browser"]), false);
  assert.equal(runsCommand("echo hi; agent-browser close", ["agent-browser"]), true);
});

test("a truncated transcript line is ignored", () => {
  assert.equal(parseTranscript('{"type":"system"}\n{"type":"res').length, 1);
});

// Forbidden uses (16/11): the real patterns of config/tools.json, so a typo in the JSON shows here.
const playwriter = (JSON.parse(readFileSync(new URL("../../config/tools.json", import.meta.url), "utf8")) as { tools: Array<{ id: string; forbidden?: Array<{ pattern: string; reason: string }> }> })
  .tools.find((t) => t.id === "playwriter")!.forbidden!;
const bash = (command: string) => use("Bash", { command });
const forbiddenOf = (command: string) => createForbiddenGuard(playwriter)(bash(command));

test("forbidden: the headless session of the first Playwriter trial is caught", () => {
  assert.match(forbiddenOf('cd "C:/w"; playwriter session new --browser headless --tab-group estatein 2>&1 | tail -5')!, /without its extension/);
});

test("forbidden: cloud, direct CDP and its own Chrome are caught too", () => {
  for (const c of ["playwriter session new --browser=cloud", "playwriter session new --direct", "PLAYWRITER_DIRECT=1 playwriter -s 1 -e x", "playwriter browser start"]) {
    assert.notEqual(forbiddenOf(c), null, c);
  }
});

test("forbidden: the extension session and normal calls pass", () => {
  for (const c of ["playwriter session new", "playwriter session new --tab-group estatein", "playwriter -s 1 -e \"await page.goto('http://localhost:5173')\"", "playwriter session list", "playwriter browser install"]) {
    assert.equal(forbiddenOf(c), null, c);
  }
});

test("forbidden: a tool without forbidden uses never stops the session", () => {
  assert.equal(createForbiddenGuard()(bash("playwriter session new --browser headless")), null);
});

test("checkSession fails an attempt that used the tool in a forbidden way", () => {
  const events = [init(), bash("playwriter session new --browser headless"), ok];
  const v = checkSession(events, [], true, undefined, undefined, playwriter);
  assert.equal(v.valid, false);
  assert.match(v.failures[0], /forbidden use of the tool/);
});

// The strict control (17/11): no browser at all, in commands and in the files the agent writes.
const strict = (JSON.parse(readFileSync(new URL("../../config/tools.json", import.meta.url), "utf8")) as { tools: Array<{ id: string; forbidden?: Array<{ pattern: string; reason: string }> }> })
  .tools.find((t) => t.id === "strict-control")!.forbidden!;
const strictOf = (event: Record<string, unknown>) => createForbiddenGuard(strict)(event);

test("strict control: the homemade loops of the first controls are caught", () => {
  // Sonnet control: a script written with Write, then run with `node` (a command naming no browser).
  assert.match(strictOf(use("Write", { file_path: "probe.mjs", content: 'import { chromium } from "playwright";\nconst b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });' }))!, /browser/);
  // Opus control: Edge started headless with a debugging port.
  assert.notEqual(strictOf(bash('"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --remote-debugging-port=9222 about:blank &')), null);
  // Looking for a browser is already leaving the condition.
  assert.notEqual(strictOf(bash("where chrome msedge 2>/dev/null")), null);
  assert.notEqual(strictOf(use("Edit", { file_path: "x.mjs", old_string: "a", new_string: "const p = await puppeteer.launch();" })), null);
  assert.notEqual(strictOf(use("MultiEdit", { file_path: "x.mjs", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "require('Playwright')" }] })), null);
});

test("strict control: the normal work of a trial passes", () => {
  for (const c of ["npm run build", "npx tsc --noEmit", "curl -s http://localhost:5173/ | head", "git add -A && git commit -m \"feat: hero section\"", "node -e \"console.log(require('./mockup/design.json').frames)\"", "ls mockup/assets | head"]) {
    assert.equal(strictOf(bash(c)), null, c);
  }
  assert.equal(strictOf(use("Write", { file_path: "src/Hero.tsx", content: "export function Hero() { return <section className=\"hero\"><h1>Discover Your Dream Property</h1></section>; }" })), null);
  assert.equal(strictOf(use("Write", { file_path: "src/hero.css", content: ".hero { display: grid; } /* Safari and Chrome round sub-pixels */" })), null);
});

test("the usage limit is told apart from a broken tool", () => {
  assert.equal(isUsageLimit(["session error (success): You've hit your 5-hour limit · resets 12:30am (Europe/Paris)"]), true);
  assert.equal(isUsageLimit(["session error (success): You've hit your weekly limit"]), true);
  assert.equal(isUsageLimit(["MCP server playwright not connected"]), false);
  assert.equal(isUsageLimit([]), false);
});

test("a session that reached the usage limit's grace period is cut, even with a successful result", () => {
  const init = { type: "system", subtype: "init", mcp_servers: [] };
  const ok = { type: "result", subtype: "success", is_error: false, result: "done" };
  const grace = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", rateLimitGraceActive: true } };
  const warning = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95 } };
  const cut = checkSession([init, grace, ok], [], true);
  assert.equal(cut.valid, false);
  assert.equal(isUsageLimit(cut.failures), true);
  assert.equal(checkSession([init, warning, ok], [], true).valid, true);
});
