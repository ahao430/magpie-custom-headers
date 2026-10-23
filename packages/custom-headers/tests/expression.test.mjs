// PLAN §10.2 表达式测试
import { describe, test, expect } from "bun:test";
import { evaluate, validate, refs, splitTop } from "../lib/expression.mjs";

const R = (map) => (ref) => (ref in map ? { ok: true, value: map[ref] } : { ok: false });

describe("expression syntax", () => {
  test.each([
    ["plain", "fixed text"],
    ["'quoted'", null],
    ["${a.b}", null],
    ["pre ${a.b} post", null],
    ["${a} || ${b} || 'z'", null],
    ["a||b", null], // `||` needs no spaces
    ["'a || b'", null], // || inside quotes is literal
  ])("accepts %j", (expr) => {
    expect(() => validate(expr)).not.toThrow();
  });
  test.each([
    ["${a.b", "unclosed"],
    ["'open", "unterminated"],
    ["a || || b", "empty || operand"],
    ["|| b", "starts with"],
    ["a ||", "ends with"],
    ["${}", "empty operand"],
    ["${'just text'}", "no variable"],
    ["${${a}}", "nested"],
    ["${a", "unclosed"],
  ])("rejects %s", (expr, msg) => {
    expect(() => validate(expr)).toThrow(msg); // toThrow(string) = substring
  });
  test("bare identifiers inside a group are refs", () => {
    expect(() => validate("${a.b}")).not.toThrow();
    expect(() => validate("${a || 'x'}")).not.toThrow();
    expect(evaluate("${a || 'x'}", R({ a: "" })).value).toBe("x");
    expect(evaluate("${a b}", R({ a: "A", b: "B" })).value).toBe("A B"); // template inside braces
  });
  test("refs lists variables in order", () => {
    expect(refs("${package.name || project.name || 'x'}")).toEqual(["package.name", "project.name"]);
    expect(refs("a=${a.b}; c=${d.e}")).toEqual(["a.b", "d.e"]);
  });
  test("splitTop keeps quoted and braced || together", () => {
    expect(splitTop("'a || b' || c")).toEqual(["'a || b' ", " c"]);
    expect(splitTop("${x.y} || w")).toEqual(["${x.y} ", " w"]);
  });
});

describe("expression evaluation", () => {
  test("fixed string", () => {
    expect(evaluate("development", R({}))).toEqual({ ok: true, value: "development" });
  });
  test("quotes are literal: || and ${} inside them never act", () => {
    expect(evaluate("'a || b'", R({})).value).toBe("a || b");
    expect(evaluate("'a\\'b'", R({})).value).toBe("a'b"); // \' -> '
    expect(evaluate("'a\\\\b'", R({})).value).toBe("a\\b"); // \\ -> \
    // the YAML layer owns outer quotes; mixing happens after they are gone
    expect(evaluate("hello ${a}", R({ a: "world" })).value).toBe("hello world");
  });
  test("single variable", () => {
    expect(evaluate("${git.branch}", R({ "git.branch": "feature/x" }))).toEqual({ ok: true, value: "feature/x" });
  });
  test("mixed template keeps order", () => {
    expect(evaluate("project=${p.name}; branch=${git.branch}", R({ "p.name": "api", "git.branch": "main" })))
      .toEqual({ ok: true, value: "project=api; branch=main" });
  });
  test("fallback takes the first useful value", () => {
    expect(evaluate("${a} || ${b} || 'z'", R({ b: "bee" })).value).toBe("bee");
    expect(evaluate("${a} || ${b} || 'z'", R({ a: "ay", b: "bee" })).value).toBe("ay");
    expect(evaluate("${a} || ${b} || 'z'", R({})).value).toBe("z");
  });
  test("empty and whitespace values are skipped, not used", () => {
    expect(evaluate("${a} || 'z'", R({ a: "" })).value).toBe("z");
    expect(evaluate("${a} || 'z'", R({ a: "   " })).value).toBe("z");
  });
  test("double-quoted literals stay literal (YAML strips its own quotes first)", () => {
    expect(evaluate('"hello ${a}"', R({ a: "world" })).value).toBe("hello ${a}");
  });
  test("all missing -> ok:false with what was tried", () => {
    const r = evaluate("${a} || ${b.c}", R({}));
    expect(r.ok).toBe(false);
    expect(r.tried).toEqual(["a", "b.c"]);
  });
  test("template with one missing var fails the whole term", () => {
    expect(evaluate("pre-${a}-post || 'z'", R({})).value).toBe("z");
  });
  test("invalid syntax throws (not a silent literal)", () => {
    expect(() => evaluate("${a", R({}))).toThrow();
  });
  test("unknown variable is a miss, never literal text", () => {
    expect(evaluate("${nope.nope} || 'z'", R({})).value).toBe("z");
    expect(evaluate("${nope.nope}", R({})).ok).toBe(false);
  });
});
