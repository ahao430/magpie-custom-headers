// Shared helpers for the tests: throwaway git repos and config files.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function tempDir(prefix = "magpie-ch-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function gitInit(dir, { branch = "main", commit = true } = {}) {
  const g = (args) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  g(["init", "-q", "-b", branch]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "test"]);
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "a\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
  }
  return dir;
}

export function gitRun(dir, args) {
  return execFileSync("git", args, { cwd: dir, windowsHide: true }).toString().trim();
}

export function writeConfig(dir, text, name = ".magpie-headers") {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

export function writePackage(dir, obj) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(obj));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
