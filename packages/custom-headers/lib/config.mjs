// .magpie-headers: find, read, parse, validate, cache.
//
// Lookup walks up from the request's working directory and the first file
// wins (PLAN §3.1). The parsed result is cached per path and revalidated by
// mtime+size, so editing the file takes effect on the next request without
// any restart.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { parse as parseYAML, ConfigError } from "./yaml.mjs";
import { validate as validateExpression } from "./expression.mjs";

export const CONFIG_NAME = ".magpie-headers";
export { ConfigError };

const POLICIES = new Set(["preserve", "override", "merge"]);
const MISSING = new Set(["omit", "empty", "fallback"]);

// Headers the plugin must never manage (PLAN §3.4/§9.1). Matched
// case-insensitively: the exact credential headers, api-key names, and
// names that begin or end with a credential word (X-Auth-Token is refused,
// X-Token-Count is fine).
const FORBIDDEN = (name) => {
  const n = name.toLowerCase();
  return (
    n === "authorization" ||
    n === "proxy-authorization" ||
    n === "cookie" ||
    n === "set-cookie" ||
    /api[-_]?key/.test(n) ||
    // a name that begins or ends with a credential word (X-Auth-Token is
    // refused; X-Token-Count is fine)
    /(^|[-_])(token|secret|password|passwd|credentials?)$/.test(n) ||
    /^(token|secret|password|passwd|credentials?)([-_]|$)/.test(n)
  );
};

const NAME_OK = /^[A-Za-z0-9!#$%&'*+\-.^`|~]+$/;

// findConfig walks up from dir; null when nothing is found.
export function findConfig(dir) {
  let cur = dir;
  for (;;) {
    const p = join(cur, CONFIG_NAME);
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// validate turns a parsed object into a checked config, throwing
// ConfigError with a precise message on anything wrong.
export function validate(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("top level must be a mapping of keys to values");
  }
  const KNOWN = new Set([
    "enabled", "conflictPolicy", "mergeSeparator", "mergeUnique",
    "onMissing", "fallbackValue", "projectName", "headers",
  ]);
  for (const k of Object.keys(raw)) {
    if (!KNOWN.has(k)) throw new ConfigError(`unknown field "${k}"`);
  }
  const cfg = {
    enabled: true,
    conflictPolicy: "override",
    mergeSeparator: ",",
    mergeUnique: true,
    onMissing: "omit",
    fallbackValue: "",
    projectName: "",
    headers: {},
  };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new ConfigError('"enabled" must be true or false');
    cfg.enabled = raw.enabled;
  }
  if (raw.conflictPolicy !== undefined) {
    if (!POLICIES.has(raw.conflictPolicy)) {
      throw new ConfigError(`"conflictPolicy" must be one of preserve / override / merge, got "${raw.conflictPolicy}"`);
    }
    cfg.conflictPolicy = raw.conflictPolicy;
  }
  if (raw.mergeSeparator !== undefined) {
    if (typeof raw.mergeSeparator !== "string") throw new ConfigError('"mergeSeparator" must be a string');
    cfg.mergeSeparator = raw.mergeSeparator;
  }
  if (raw.mergeUnique !== undefined) {
    if (typeof raw.mergeUnique !== "boolean") throw new ConfigError('"mergeUnique" must be true or false');
    cfg.mergeUnique = raw.mergeUnique;
  }
  if (raw.onMissing !== undefined) {
    if (!MISSING.has(raw.onMissing)) {
      throw new ConfigError(`"onMissing" must be one of omit / empty / fallback, got "${raw.onMissing}"`);
    }
    cfg.onMissing = raw.onMissing;
  }
  if (raw.fallbackValue !== undefined) {
    if (typeof raw.fallbackValue !== "string") throw new ConfigError('"fallbackValue" must be a string');
    if (/[\r\n]/.test(raw.fallbackValue)) throw new ConfigError('"fallbackValue" must not contain CR/LF');
    cfg.fallbackValue = raw.fallbackValue;
  }
  if (raw.projectName !== undefined) {
    if (typeof raw.projectName !== "string") throw new ConfigError('"projectName" must be a string');
    cfg.projectName = raw.projectName;
  }
  if (raw.headers !== undefined) {
    const h = raw.headers;
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      throw new ConfigError('"headers" must be a mapping of header name to value');
    }
    for (const name of Object.keys(h)) {
      if (!NAME_OK.test(name)) throw new ConfigError(`invalid header name "${name}"`);
      if (FORBIDDEN(name)) throw new ConfigError(`header "${name}" is an authentication/credential field the plugin will not manage`);
      let value = h[name];
      // PLAN §3.3: every header value is a string template — YAML's
      // true/false/123 must not turn into anything but text
      if (typeof value === "boolean" || typeof value === "number") value = String(value);
      if (typeof value !== "string") throw new ConfigError(`header "${name}": value must be a string`);
      if (/[\r\n\0]/.test(value)) throw new ConfigError(`header "${name}": value must not contain CR/LF/NUL`);
      validateExpression(value); // throws on bad syntax, names the problem
      cfg.headers[name] = value;
    }
  }
  return cfg;
}

// cache of parsed+validated configs, keyed by path, rechecked by mtime+size.
const cache = new Map();

// load finds and loads the config for dir. Returns { path, config } or
// null when there is no config file. Throws ConfigError on a broken config.
export function load(dir) {
  const path = findConfig(dir);
  if (!path) return null;
  const st = statSync(path);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return { path, config: hit.config };
  const text = readFileSync(path, "utf8");
  const raw = parseYAML(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new ConfigError("config file is empty");
  }
  const config = validate(raw);
  cache.set(path, { key, config });
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return { path, config };
}

export function clearConfigCache() {
  cache.clear();
}

// walkUp is exposed for tests of findConfig's parent walk.
export const _internal = { FORBIDDEN, NAME_OK, findConfigUp: findConfig, sep };
