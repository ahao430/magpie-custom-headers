// PLAN §10.3 Header 策略测试
import { describe, test, expect } from "bun:test";
import { applyPolicy, mergeValues } from "../lib/policy.mjs";

const cfg = (over = {}) => ({ conflictPolicy: "override", onMissing: "omit", fallbackValue: "", mergeSeparator: ",", mergeUnique: true, ...over });
const ok = (name, value) => ({ name, ok: true, value });
const miss = (name) => ({ name, ok: false, value: undefined });

describe("conflictPolicy", () => {
  test("injects when the header does not exist", () => {
    expect(applyPolicy({ config: cfg(), entries: [ok("X-A", "1")], existing: {} })).toEqual([["X-A", "1"]]);
  });
  test("override replaces an existing value", () => {
    expect(applyPolicy({ config: cfg({ conflictPolicy: "override" }), entries: [ok("X-A", "new")], existing: { "x-a": "old" } }))
      .toEqual([["X-A", "new"]]);
  });
  test("preserve keeps the existing value", () => {
    expect(applyPolicy({ config: cfg({ conflictPolicy: "preserve" }), entries: [ok("X-A", "new")], existing: { "x-a": "old" } }))
      .toEqual([]);
  });
  test("preserve injects when absent", () => {
    expect(applyPolicy({ config: cfg({ conflictPolicy: "preserve" }), entries: [ok("X-A", "new")], existing: {} }))
      .toEqual([["X-A", "new"]]);
  });
  test("merge joins existing and computed", () => {
    expect(applyPolicy({ config: cfg({ conflictPolicy: "merge" }), entries: [ok("X-A", "b")], existing: { "x-a": "a" } }))
      .toEqual([["X-A", "a,b"]]);
  });
  test("merge dedupes case-insensitively", () => {
    expect(mergeValues("req-1, REQ-2", "req-2,req-3", ",", true)).toBe("req-1,REQ-2,req-3");
  });
  test("merge without dedupe keeps everything", () => {
    expect(mergeValues("a", "a", ",", false)).toBe("a,a");
  });
  test("custom separator", () => {
    expect(mergeValues("a;b", "c", ";", true)).toBe("a;b;c");
  });
  test("merge with no existing value just sets", () => {
    expect(applyPolicy({ config: cfg({ conflictPolicy: "merge" }), entries: [ok("X-A", "a")], existing: {} }))
      .toEqual([["X-A", "a"]]);
  });
  test("reads existing headers via Headers.get too", () => {
    const existing = new Headers({ "x-a": "old" });
    expect(applyPolicy({ config: cfg({ conflictPolicy: "preserve" }), entries: [ok("X-A", "new")], existing }))
      .toEqual([]);
  });
});

describe("onMissing", () => {
  test("omit sends nothing", () => {
    expect(applyPolicy({ config: cfg({ onMissing: "omit" }), entries: [miss("X-A")], existing: {} })).toEqual([]);
  });
  test("empty sends an empty string", () => {
    expect(applyPolicy({ config: cfg({ onMissing: "empty" }), entries: [miss("X-A")], existing: {} }))
      .toEqual([["X-A", ""]]);
  });
  test("fallback uses fallbackValue", () => {
    expect(applyPolicy({ config: cfg({ onMissing: "fallback", fallbackValue: "unknown" }), entries: [miss("X-A")], existing: {} }))
      .toEqual([["X-A", "unknown"]]);
  });
  test("missing policy does not apply to successful entries", () => {
    expect(applyPolicy({ config: cfg({ onMissing: "fallback", fallbackValue: "x" }), entries: [ok("X-A", "real")], existing: {} }))
      .toEqual([["X-A", "real"]]);
  });
});

describe("isolation", () => {
  test("entries not configured are never touched", () => {
    const set = applyPolicy({ config: cfg(), entries: [ok("X-A", "1")], existing: { "x-b": "keep", "x-c": "keep" } });
    expect(set).toEqual([["X-A", "1"]]);
  });
  test("multiple entries keep their order", () => {
    const set = applyPolicy({ config: cfg(), entries: [ok("X-B", "2"), ok("X-A", "1")], existing: {} });
    expect(set).toEqual([["X-B", "2"], ["X-A", "1"]]);
  });
});
