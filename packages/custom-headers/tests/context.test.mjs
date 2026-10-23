// PLAN §10.4 Git 与项目测试 —— real temp git repos, real git subprocesses.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { makeResolver, stripCredentials, clearContextCache } from "../lib/context.mjs";
import { tempDir, gitInit, gitRun, writePackage, cleanup } from "./helpers.mjs";

const dirs = [];
const tmp = (p) => {
  const d = tempDir();
  if (p) mkdirSync(join(d, p), { recursive: true });
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach(cleanup));

const resolveIn = (cwd, ref, extra = {}) => makeResolver({ cwd, ...extra })(ref);

describe("git variables", () => {
  test("feature branch reports its full name", () => {
    const dir = gitInit(tmp(), { branch: "main" });
    gitRun(dir, ["checkout", "-qb", "feature/REQ-1234-login"]);
    expect(resolveIn(dir, "git.branch").value).toBe("feature/REQ-1234-login");
    expect(resolveIn(dir, "git.branch").value).not.toBe("REQ-1234-login");
  });
  test("main and master are kept as-is", () => {
    expect(resolveIn(gitInit(tmp(), { branch: "main" }), "git.branch").value).toBe("main");
    expect(resolveIn(gitInit(tmp(), { branch: "master" }), "git.branch").value).toBe("master");
  });
  test("commit is short, commit_full is the same hash", () => {
    const dir = gitInit(tmp());
    const short = resolveIn(dir, "git.commit").value;
    const full = resolveIn(dir, "git.commit_full").value;
    expect(short).toMatch(/^[0-9a-f]{7}$/);
    expect(full).toMatch(/^[0-9a-f]{40}$/);
    expect(full.startsWith(short)).toBe(true);
  });
  test("repo with no commits yet", () => {
    const dir = gitInit(tmp(), { commit: false });
    expect(resolveIn(dir, "git.branch").value).toMatch(/^(main|master)$/);
    expect(resolveIn(dir, "git.commit").ok).toBe(false);
    expect(resolveIn(dir, "git.commit_full").ok).toBe(false);
  });
  test("detached HEAD", () => {
    const dir = gitInit(tmp());
    gitRun(dir, ["checkout", "-q", "--detach", "HEAD"]);
    expect(resolveIn(dir, "git.branch").ok).toBe(false); // no branch name exists
    expect(resolveIn(dir, "git.commit").ok).toBe(true);
    expect(resolveIn(dir, "git.repo_root").ok).toBe(true);
  });
  test("non-git directory", () => {
    const dir = tmp();
    for (const ref of ["git.branch", "git.commit", "git.repo_root", "git.repo_name", "git.remote_url"]) {
      expect(resolveIn(dir, ref).ok).toBe(false);
    }
  });
  test("branch switch shows up on the next resolve", () => {
    const dir = gitInit(tmp(), { branch: "main" });
    expect(resolveIn(dir, "git.branch").value).toBe("main");
    gitRun(dir, ["checkout", "-qb", "feature/next"]);
    expect(resolveIn(dir, "git.branch").value).toBe("feature/next");
    gitRun(dir, ["checkout", "-q", "main"]);
    expect(resolveIn(dir, "git.branch").value).toBe("main");
  });
  test("repo_root and repo_name", () => {
    const dir = gitInit(tmp());
    const sub = join(dir, "web", "deep");
    mkdirSync(sub, { recursive: true });
    // git reports the canonical path (macOS resolves /var to /private/var)
    const top = gitRun(dir, ["rev-parse", "--show-toplevel"]);
    expect(resolveIn(sub, "git.repo_root").value).toBe(top);
    expect(resolveIn(sub, "git.repo_name").value).toBe(top.split("/").pop());
  });
  test("remote_url is stripped of credentials", () => {
    const dir = gitInit(tmp());
    gitRun(dir, ["remote", "add", "origin", "https://user:pass123@example.com/owner/repo.git"]);
    expect(resolveIn(dir, "git.remote_url").value).toBe("https://example.com/owner/repo.git");
  });
  test("remote_url is missing when no remote", () => {
    const dir = gitInit(tmp());
    expect(resolveIn(dir, "git.remote_url").ok).toBe(false);
  });
  test("stripCredentials leaves safe urls alone", () => {
    expect(stripCredentials("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
    expect(stripCredentials("https://example.com/a/b")).toBe("https://example.com/a/b");
    expect(stripCredentials("ssh://u:p@h/x")).toBe("ssh://h/x");
  });
});

describe("path handling", () => {
  test("spaces and non-ascii in the path", () => {
    const dir = gitInit(tmp("ch-空间 "));
    const sub = join(dir, "my project/中文目录");
    mkdirSync(sub, { recursive: true });
    expect(resolveIn(sub, "git.repo_root").value).toBe(gitRun(dir, ["rev-parse", "--show-toplevel"]));
    expect(resolveIn(sub, "project.path").value).toBe(sub);
  });
});

describe("package variables", () => {
  test("nearest package.json wins in a monorepo", () => {
    const dir = gitInit(tmp());
    writePackage(dir, { name: "root-app", version: "1.0.0" });
    const web = join(dir, "web");
    mkdirSync(web, { recursive: true });
    writePackage(web, { name: "web-app", version: "2.3.4" });
    expect(resolveIn(web, "package.name").value).toBe("web-app");
    expect(resolveIn(web, "package.version").value).toBe("2.3.4");
    expect(resolveIn(dir, "package.name").value).toBe("root-app");
    // project.name stays the repo, package.name the nearest package
    expect(resolveIn(web, "project.name").value).toBe(dir.split("/").pop());
  });
  test("no package.json anywhere", () => {
    const dir = gitInit(tmp());
    expect(resolveIn(dir, "package.name").ok).toBe(false);
    expect(resolveIn(dir, "package.version").ok).toBe(false);
  });
  test("invalid package.json is missing, not fatal", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(resolveIn(dir, "package.name").ok).toBe(false);
    expect(resolveIn(dir, "project.path").value).toBe(dir);
  });
  test("package.json without name/version", () => {
    const dir = tmp();
    writePackage(dir, { private: true });
    expect(resolveIn(dir, "package.name").ok).toBe(false);
  });
  test("edit to package.json is picked up", () => {
    const dir = tmp();
    const p = join(dir, "package.json");
    writePackage(dir, { name: "before" });
    expect(resolveIn(dir, "package.name").value).toBe("before");
    writePackage(dir, { name: "after" });
    expect(resolveIn(dir, "package.name").value).toBe("after");
  });
});

describe("project variables", () => {
  test("project.path is the working directory, not the repo root", () => {
    const dir = gitInit(tmp());
    const sub = join(dir, "web");
    mkdirSync(sub, { recursive: true });
    expect(resolveIn(sub, "project.path").value).toBe(sub);
    expect(resolveIn(sub, "git.repo_root").value).toBe(gitRun(dir, ["rev-parse", "--show-toplevel"]));
  });
  test("config projectName wins over repo name", () => {
    const dir = gitInit(tmp());
    expect(makeResolver({ cwd: dir, projectName: "平台" })("project.name").value).toBe("平台");
  });
  test("non-git directory falls back to the directory name", () => {
    const dir = tmp();
    expect(resolveIn(dir, "project.name").value).toBe(dir.split("/").pop());
  });
});

describe("agent and session", () => {
  test("present when the channel provides them", () => {
    const dir = tmp();
    expect(makeResolver({ cwd: dir, agent: "claude", session: "s-1" })("agent.name").value).toBe("claude");
    expect(makeResolver({ cwd: dir, session: "s-1" })("session.id").value).toBe("s-1");
  });
  test("missing when absent — never faked", () => {
    const dir = tmp();
    expect(resolveIn(dir, "agent.name").ok).toBe(false);
    expect(resolveIn(dir, "session.id").ok).toBe(false);
  });
});

describe("unknown variables", () => {
  test("unknown ref is a miss (engine reports it, never literal text)", () => {
    expect(resolveIn(tmp(), "nope.nope").ok).toBe(false);
  });
});

describe("concurrency of resolvers", () => {
  test("two projects resolve independently", () => {
    const a = gitInit(tmp(), { branch: "main" });
    gitRun(a, ["checkout", "-qb", "feature/a"]);
    const b = gitInit(tmp(), { branch: "main" });
    gitRun(b, ["checkout", "-qb", "feature/b"]);
    const ra = makeResolver({ cwd: a });
    const rb = makeResolver({ cwd: b });
    expect(ra("git.branch").value).toBe("feature/a");
    expect(rb("git.branch").value).toBe("feature/b");
    expect(ra("git.branch").value).toBe("feature/a");
  });
});

describe("cache", () => {
  test("clearContextCache drops everything", () => {
    const dir = gitInit(tmp());
    expect(resolveIn(dir, "git.branch").ok).toBe(true);
    clearContextCache();
    expect(resolveIn(dir, "git.branch").ok).toBe(true); // still resolvable, just re-read
  });
});
