// 端到端（引擎级）：resolveHeaders 把 配置→表达式→策略 串起来（§10.6 的引擎侧前置）。
// 真正的 HTTP 端到端在沙箱里做（FEASIBILITY.md §6）。
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveHeaders } from "../lib/inject.mjs";
import { tempDir, gitInit, gitRun, writeConfig, writePackage, cleanup } from "./helpers.mjs";

const dirs = [];
const tmp = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach(cleanup));

const CFG = `
headers:
  X-Requirement-Id: "\${git.branch}"
  X-Project-Name: "\${package.name || project.name || 'unknown'}"
  X-Project-Path: "\${project.path}"
  X-Git-Commit: "\${git.commit}"
  X-Environment: development
`;

describe("resolveHeaders", () => {
  test("no config -> no headers", () => {
    const dir = tmp();
    const out = resolveHeaders({ cwd: dir, agent: "claude", session: "s" });
    expect(out.set).toEqual([]);
    expect(out.notes).toEqual([]);
  });
  test("full flow: git branch, package fallback, fixed values", () => {
    const repo = gitInit(tmp(), { branch: "main" });
    gitRun(repo, ["checkout", "-qb", "feature/REQ-42-api"]);
    writePackage(repo, { name: "api", version: "1.2.3" });
    writeConfig(repo, CFG);
    const out = resolveHeaders({ cwd: repo, agent: "claude", session: "s-1" });
    const get = (n) => out.set.find(([k]) => k === n)?.[1];
    expect(get("X-Requirement-Id")).toBe("feature/REQ-42-api");
    expect(get("X-Project-Name")).toBe("api");
    expect(get("X-Project-Path")).toBe(repo);
    expect(get("X-Git-Commit")).toMatch(/^[0-9a-f]{7}$/);
    expect(get("X-Environment")).toBe("development");
    expect(out.notes).toEqual([]);
  });
  test("fallback chain lands on project.name then 'unknown'", () => {
    const repo = gitInit(tmp(), { branch: "main" });
    writeConfig(repo, "headers:\n  X-P: \"${package.name || project.name}\"\n  X-Q: \"${package.name || 'unknown'}\"\n");
    const get = (n) => resolveHeaders({ cwd: repo }).set.find(([k]) => k === n)?.[1];
    expect(get("X-P")).toBe(repo.split("/").pop());
    expect(get("X-Q")).toBe("unknown");
  });
  test("missing variable + omit -> header not sent, note recorded", () => {
    const repo = gitInit(tmp(), { commit: false });
    writeConfig(repo, "headers:\n  X-Git-Commit: \"${git.commit}\"\n");
    const out = resolveHeaders({ cwd: repo });
    expect(out.set).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/X-Git-Commit/);
  });
  test("preserve keeps what the request already had", () => {
    const repo = gitInit(tmp(), { branch: "main" });
    writeConfig(repo, "conflictPolicy: preserve\nheaders:\n  X-Trace: \"${git.branch}\"\n");
    const out = resolveHeaders({ cwd: repo, existing: new Headers({ "x-trace": "from-client" }) });
    expect(out.set).toEqual([]);
    const out2 = resolveHeaders({ cwd: repo, existing: {} });
    expect(out2.set).toEqual([["X-Trace", "main"]]);
  });
  test("disabled config injects nothing", () => {
    const repo = gitInit(tmp());
    writeConfig(repo, "enabled: false\nheaders:\n  X-A: b\n");
    expect(resolveHeaders({ cwd: repo }).set).toEqual([]);
  });
  test("broken config -> no headers, diagnostic, request unaffected", () => {
    const repo = gitInit(tmp());
    writeConfig(repo, "headers:\n  Authorization: stolen\n");
    const out = resolveHeaders({ cwd: repo });
    expect(out.set).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/will not manage/);
  });
  test("monorepo: subpackage gets the subpackage identity", () => {
    const repo = gitInit(tmp(), { branch: "main" });
    writePackage(repo, { name: "monorepo-root", version: "0.0.1" });
    const web = join(repo, "web");
    mkdirSync(web, { recursive: true });
    writePackage(web, { name: "web-app", version: "3.1.4" });
    writeConfig(repo, "headers:\n  X-P: \"${package.name}\"\n  X-V: \"${package.version}\"\n");
    const get = (n, cwd) => resolveHeaders({ cwd }).set.find(([k]) => k === n)?.[1];
    expect(get("X-P", web)).toBe("web-app");
    expect(get("X-V", web)).toBe("3.1.4");
    expect(get("X-P", repo)).toBe("monorepo-root");
  });
  test("agent/session variables flow through when provided", () => {
    const repo = gitInit(tmp());
    writeConfig(repo, "headers:\n  X-Requester: \"${agent.name}\"\n");
    expect(resolveHeaders({ cwd: repo, agent: "claude" }).set).toEqual([["X-Requester", "claude"]]);
    expect(resolveHeaders({ cwd: repo }).set).toEqual([]);
  });
});
