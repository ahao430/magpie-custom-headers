// Context resolvers: the variables ${...} can name (PLAN §4.2).
//
//   git.branch / git.commit / git.commit_full / git.repo_name / git.repo_root
//   git.remote_url   (credentials stripped; only resolved when referenced)
//   project.path / project.name
//   package.name / package.version
//   agent.name / session.id   (given by the caller when the channel has one)
//
// Git runs as a subprocess with a timeout; everything is cached per
// directory and refreshed by .git/HEAD's mtime, so a branch switch shows up
// on the next request without rescanning anything on every call.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const GIT_TIMEOUT = 1000;
const FALLBACK_TTL = 500; // ms, when .git/HEAD's mtime cannot be watched

function git(cwd, args) {
  return execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 1024 * 1024, windowsHide: true })
    .toString()
    .trim();
}

// stripCredentials removes user:password@ from an http(s) remote URL.
// scp-like remotes (git@host:path) keep their shape: nothing secret there.
export function stripCredentials(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i, "$1");
}

// repoAt resolves the repo root for cwd, cached until .git/HEAD changes.
const repoCache = new Map();

function headStamp(root) {
  // .git may be a directory (usual), a file (worktree/submodule) or absent
  try {
    const st = statSync(join(root, ".git"));
    return st.isDirectory() ? statSync(join(root, ".git", "HEAD")).mtimeMs : Date.now();
  } catch {
    return Date.now();
  }
}

function repoAt(cwd, log) {
  const hit = repoCache.get(cwd);
  if (hit && hit.stamp === headStamp(hit.root)) return hit;
  let root;
  try {
    root = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (e) {
    if (log) log(`git repo lookup failed in ${cwd}`);
    return null; // not a repo, or git broken: everything git.* is missing
  }
  const info = { root, stamp: headStamp(root) };
  repoCache.set(cwd, info);
  if (repoCache.size > 64) repoCache.delete(repoCache.keys().next().value);
  return info;
}

// gitInfo reads branch/commit for cwd, re-reading when HEAD's mtime moved.
const gitInfoCache = new Map(); // cwd -> { root, stamp, branch, commit, full }

function gitInfo(cwd, log) {
  const repo = repoAt(cwd, log);
  if (!repo) return null;
  const stamp = headStamp(repo.root);
  const hit = gitInfoCache.get(cwd);
  if (hit && hit.stamp === stamp) return hit;
  const info = { root: repo.root, stamp };
  try {
    // --show-current, not --abbrev-ref HEAD: an unborn branch (no commits
    // yet) errors the latter, and a detached HEAD prints "HEAD" there
    // while here it must count as no branch (PLAN §10.4).
    info.branch = git(cwd, ["branch", "--show-current"]) || undefined;
  } catch (e) {
    if (log) log("git branch lookup failed");
  }
  try {
    info.commit = git(cwd, ["rev-parse", "--short=7", "HEAD"]) || undefined;
    info.full = git(cwd, ["rev-parse", "HEAD"]) || undefined;
  } catch (e) {
    if (log) log("git commit lookup failed");
  }
  gitInfoCache.set(cwd, info);
  if (gitInfoCache.size > 64) gitInfoCache.delete(gitInfoCache.keys().next().value);
  return info;
}

// packageAt finds the nearest package.json at cwd or above. Cached per cwd
// until the file's mtime or existence changes (PLAN §8.2).
const packageCache = new Map(); // cwd -> { stamp, path, data | null }

function packageAt(cwd, log) {
  const probe = (dir) => {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    try {
      const st = statSync(p);
      return { p, stamp: `${st.mtimeMs}:${st.size}` };
    } catch {
      return null;
    }
  };
  let cur = cwd;
  let found = probe(cur);
  while (!found) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
    found = probe(cur);
  }
  const key = cwd;
  const stamp = found ? found.stamp : "none";
  const hit = packageCache.get(key);
  if (hit && hit.stamp === stamp) return hit.data;
  let data = null;
  if (found) {
    try {
      const raw = JSON.parse(readFileSync(found.p, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) data = raw;
      else if (log) log(`${found.p}: not a JSON object`);
    } catch (e) {
      if (log) log(`${found.p}: unreadable or invalid JSON`);
    }
  }
  packageCache.set(key, { stamp, data });
  if (packageCache.size > 256) packageCache.delete(packageCache.keys().next().value);
  return data;
}

// KNOWN lists the variables resolve() can answer for (diagnostics: an
// unknown name must be told apart from a failed lookup, PLAN §5.5).
export const KNOWN = new Set([
  "git.branch", "git.commit", "git.commit_full", "git.repo_name", "git.repo_root", "git.remote_url",
  "project.path", "project.name",
  "package.name", "package.version",
  "agent.name", "session.id",
]);

// makeResolver builds the resolve(ref) function the expression engine uses.
// projectName is the config's own override (PLAN §4.2: config first).
export function makeResolver({ cwd, agent, session, projectName, log } = {}) {
  if (!cwd) throw new Error("cwd is required");
  const dir = { cwd };
  return function resolve(ref) {
    switch (ref) {
      case "project.path":
        return { ok: true, value: dir.cwd };
      case "project.name": {
        if (projectName) return { ok: true, value: projectName };
        const repo = repoAt(dir.cwd, log);
        if (repo) return { ok: true, value: basename(repo.root) };
        return { ok: true, value: basename(dir.cwd) };
      }
      case "package.name": {
        const pkg = packageAt(dir.cwd, log);
        return pkg && typeof pkg.name === "string" && pkg.name ? { ok: true, value: pkg.name } : { ok: false };
      }
      case "package.version": {
        const pkg = packageAt(dir.cwd, log);
        return pkg && typeof pkg.version === "string" && pkg.version ? { ok: true, value: pkg.version } : { ok: false };
      }
      case "agent.name":
        return agent ? { ok: true, value: agent } : { ok: false };
      case "session.id":
        return session ? { ok: true, value: session } : { ok: false };
      case "git.remote_url": {
        const repo = repoAt(dir.cwd, log);
        if (!repo) return { ok: false };
        const info = gitInfo(dir.cwd, log);
        try {
          const url = git(dir.cwd, ["config", "--get", "remote.origin.url"]);
          return url ? { ok: true, value: stripCredentials(url) } : { ok: false };
        } catch {
          return { ok: false };
        }
      }
    }
    if (ref.startsWith("git.")) {
      const repo = repoAt(dir.cwd, log);
      if (!repo) return { ok: false };
      const info = gitInfo(dir.cwd, log);
      if (!info) return { ok: false };
      if (ref === "git.branch") return info.branch ? { ok: true, value: info.branch } : { ok: false };
      if (ref === "git.commit") return info.commit ? { ok: true, value: info.commit } : { ok: false };
      if (ref === "git.commit_full") return info.full ? { ok: true, value: info.full } : { ok: false };
      if (ref === "git.repo_root") return { ok: true, value: info.root };
      if (ref === "git.repo_name") return { ok: true, value: basename(info.root) };
    }
    return { ok: false };
  };
}

export function clearContextCache() {
  repoCache.clear();
  gitInfoCache.clear();
  packageCache.clear();
}

export const _internal = { git, stripCredentials, headStamp, FALLBACK_TTL, GIT_TIMEOUT };
