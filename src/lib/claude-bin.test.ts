import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAuth, resolveClaudeBin } from "./claude-bin.ts";

const files = (...paths: string[]) => (p: string) => paths.includes(p);
const win = { platform: "win32" as const, home: "C:\\Users\\u" };

test("CLAUDE_BIN wins over everything", () => {
  const bin = resolveClaudeBin({ ...win, env: { CLAUDE_BIN: "D:\\c.exe", PATH: "C:\\bin" }, configured: "E:\\c.exe", exists: files("D:\\c.exe", "E:\\c.exe", "C:\\bin\\claude.exe") });
  assert.deepEqual(bin, { path: "D:\\c.exe", source: "CLAUDE_BIN" });
});

test("claudeBin from the config comes before the PATH", () => {
  const bin = resolveClaudeBin({ ...win, env: { PATH: "C:\\bin" }, configured: "E:\\c.exe", exists: files("E:\\c.exe", "C:\\bin\\claude.exe") });
  assert.equal(bin.source, "claudeBin");
});

test("an explicit setting that points nowhere is an error, not skipped", () => {
  assert.throws(() => resolveClaudeBin({ ...win, env: { CLAUDE_BIN: "D:\\nope.exe" }, exists: files("C:\\Users\\u\\.local\\bin\\claude.exe") }), /CLAUDE_BIN/);
});

test("the PATH is searched with the Windows extensions", () => {
  const bin = resolveClaudeBin({ ...win, env: { PATH: "C:\\a;C:\\bin" }, exists: files("C:\\bin\\claude.exe") });
  assert.deepEqual(bin, { path: "C:\\bin\\claude.exe", source: "PATH" });
});

test("falls back to the installer's default location", () => {
  assert.equal(resolveClaudeBin({ ...win, env: {}, exists: files("C:\\Users\\u\\.local\\bin\\claude.exe") }).source, "default location");
  assert.equal(resolveClaudeBin({ platform: "linux", home: "/home/u", env: {}, exists: files("/home/u/.local/bin/claude") }).path, "/home/u/.local/bin/claude");
});

test("not found anywhere: the error lists where it looked", () => {
  assert.throws(() => resolveClaudeBin({ ...win, env: {}, exists: () => false }), /\.local\\bin\\claude\.exe/);
});

test("a .cmd shim is refused", () => {
  assert.throws(() => resolveClaudeBin({ ...win, env: { PATH: "C:\\npm" }, exists: files("C:\\npm\\claude.cmd") }), /shim/);
});

test("auth: logged in with the plan is fine", () => {
  assert.equal(checkAuth(0, '{"loggedIn":true,"authMethod":"claude.ai"}'), null);
});

test("auth: not logged in, or an API key, stops the bench", () => {
  assert.match(checkAuth(1, '{"loggedIn":false,"authMethod":"none"}')!, /not logged in/);
  assert.match(checkAuth(0, '{"loggedIn":true,"authMethod":"api_key"}')!, /API rates/);
  assert.match(checkAuth(1, "error")!, /JSON/);
});
