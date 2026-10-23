// PLAN §10.1 配置测试 + §10.4 的配置文件查找/重载部分
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { load, findConfig, validate, CONFIG_NAME } from "../lib/config.mjs";
import { parse as parseYAML } from "../lib/yaml.mjs";
import { tempDir, gitInit, writeConfig, cleanup } from "./helpers.mjs";

const GOOD = `
enabled: true
conflictPolicy: override
headers:
  X-Requirement-Id: "\${git.branch}"
  X-Environment: development
`;

describe("yaml subset", () => {
  test("parses scalars, nested maps, comments", () => {
    const raw = parseYAML("# comment\nenabled: true\nname: 'x # y'\nheaders:\n  X-A: \"1\"\n  X-B: plain\n");
    expect(raw.enabled).toBe(true);
    expect(raw.name).toBe("x # y");
    expect(raw.headers).toEqual({ "X-A": "1", "X-B": "plain" });
  });
  test("numbers and booleans reach validate as strings", () => {
    // the YAML layer keeps numbers as text; validate stringifies the rest
    const raw = parseYAML("headers:\n  X-N: 123\n  X-B: false\n");
    expect(raw.headers["X-N"]).toBe("123");
    expect(raw.headers["X-B"]).toBe(false);
    const cfg = validate(raw);
    expect(cfg.headers["X-N"]).toBe("123");
    expect(cfg.headers["X-B"]).toBe("false");
  });
  test("rejects tabs and garbage", () => {
    expect(() => parseYAML("a:\n\tb: 1")).toThrow(/tab/);
    expect(() => parseYAML("just text")).toThrow(/key: value/);
  });
  test("duplicate nested keys are an error", () => {
    expect(() => parseYAML("headers:\n  X-A: 1\n  X-A: 2")).toThrow(/duplicate/);
  });
});

describe("config validation", () => {
  test("defaults apply", () => {
    const cfg = validate(parseYAML("headers:\n  X-A: b\n"));
    expect(cfg).toMatchObject({ enabled: true, conflictPolicy: "override", onMissing: "omit", mergeSeparator: ",", mergeUnique: true });
  });
  test("root must be a mapping", () => {
    expect(() => validate(null)).toThrow(/mapping/);
    expect(() => validate([1])).toThrow(/mapping/);
  });
  test("empty file is an error at load", () => {
    const dir = tempDir();
    writeConfig(dir, "   \n# only a comment\n");
    expect(() => load(dir)).toThrow(/empty/);
    cleanup(dir);
  });
  test("unknown field is rejected", () => {
    expect(() => validate(parseYAML("nope: 1\n"))).toThrow(/unknown field "nope"/);
  });
  test.each([
    ["enabled: maybe\n", '"enabled" must be'],
    ["conflictPolicy: replace\n", "conflictPolicy"],
    ["onMissing: ignore\n", "onMissing"],
    ["mergeUnique: yes-please\nheaders: {X-A: b}\n", "mergeUnique"],
  ])("bad scalar %s", (text, msg) => {
    expect(() => validate(parseYAML(text))).toThrow(msg);
  });
  test("invalid header names", () => {
    expect(() => validate(parseYAML("headers:\n  Bad Header: x\n"))).toThrow(/invalid header name/);
    expect(() => validate(parseYAML("headers:\n  X-A{b}: x\n"))).toThrow(/invalid header name/);
  });
  test("CR/LF injection in value is rejected", () => {
    // a literal carriage return inside a quoted scalar
    expect(() => validate(parseYAML("headers:\n  X-A: 'one\rtwo'\n"))).toThrow(/CR\/LF/);
    // a line break inside the value breaks the line structure anyway
    expect(() => validate(parseYAML("headers:\n  X-A: 'one\ntwo'\n"))).toThrow();
  });
  test("auth headers are refused", () => {
    for (const name of ["Authorization", "proxy-authorization", "X-API-Key", "x-api-key", "Cookie", "Session-Token", "My-Secret"]) {
      expect(() => validate(parseYAML(`headers:\n  ${name}: x\n`))).toThrow(/will not manage/);
    }
    expect(() => validate(parseYAML("headers:\n  X-Token-Count: x\n"))).not.toThrow();
  });
  test("non-string header value", () => {
    // YAML scalar parsing keeps numbers as strings; a nested map, though, is not a string
    expect(() => validate(parseYAML("headers:\n  X-A:\n    B: 1\n"))).toThrow(/nested maps of maps|no value/);
  });
  test("bad expression is rejected at load", () => {
    expect(() => validate(parseYAML("headers:\n  X-A: \"${git.branch\"\n"))).toThrow(/unclosed/);
    expect(() => validate(parseYAML("headers:\n  X-A: \"a || || b\"\n"))).toThrow(/empty \|\| operand/);
  });
});

describe("config lookup and reload", () => {
  test("first file up the tree wins", () => {
    const repo = gitInit(tempDir());
    const sub = join(repo, "web", "deep");
    const other = join(repo, "sibling");
    mkdirSync(sub, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeConfig(repo, GOOD);
    writeConfig(join(repo, "web"), "headers:\n  X-From-Web: 1\n");
    expect(findConfig(sub)).toBe(join(repo, "web", CONFIG_NAME));
    expect(findConfig(other)).toBe(join(repo, CONFIG_NAME));
    const loaded = load(sub);
    expect(loaded.config.headers["X-From-Web"]).toBe("1");
    expect(loaded.config.headers["X-Requirement-Id"]).toBeUndefined();
    cleanup(repo);
  });
  test("no config anywhere -> null", () => {
    const dir = tempDir();
    expect(findConfig(dir)).toBeNull();
    expect(load(dir)).toBeNull();
    cleanup(dir);
  });
  test("edit takes effect on the next load without restart", () => {
    const dir = tempDir();
    const path = writeConfig(dir, "headers:\n  X-A: one\n");
    expect(load(dir).config.headers["X-A"]).toBe("one");
    writeFileSync(path, "headers:\n  X-A: two\n");
    expect(load(dir).config.headers["X-A"]).toBe("two");
    cleanup(dir);
  });
  test("broken config after an edit surfaces the error", () => {
    const dir = tempDir();
    const path = writeConfig(dir, "headers:\n  X-A: ok\n");
    load(dir);
    writeFileSync(path, "headers:\n  Authorization: nope\n");
    expect(() => load(dir)).toThrow(/will not manage/);
    cleanup(dir);
  });
  test("mtime-only change reloads", () => {
    const dir = tempDir();
    const path = writeConfig(dir, "headers:\n  X-A: one\n");
    load(dir);
    writeFileSync(path, "headers:\n  X-A: one\n"); // same size, new mtime
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(load(dir).config.headers["X-A"]).toBe("one"); // cached parse is fine either way
    cleanup(dir);
  });
  test("reads the file the findConfig found", () => {
    const dir = gitInit(tempDir());
    writeConfig(dir, GOOD);
    const { config } = load(dir);
    expect(config.headers["X-Environment"]).toBe("development");
    cleanup(dir);
  });
});
