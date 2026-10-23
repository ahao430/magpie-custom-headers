// A deliberately small YAML subset, enough for .magpie-headers and nothing
// more: comments, `key: value` scalars and one level of nested maps under a
// `key:` with no inline value. Anything else is a clear error, never a
// silent misread — the plugin's config must not be guessed at.

export class ConfigError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "ConfigError";
  }
}

// stripComment cuts an unquoted trailing `#` comment, keeping `#` inside quotes.
function stripComment(text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i);
    }
  }
  return text;
}

// parseScalar: quoted strings keep their content (minimal escapes); bare
// true/false are booleans; everything else stays a string. Numbers are kept
// as strings on purpose — header values are strings (PLAN §3.3).
export function parseScalar(raw, line) {
  const text = raw.trim();
  if (!text) return "";
  const q = text[0];
  if (q === "'" || q === '"') {
    if (text.length < 2 || text[text.length - 1] !== q) {
      throw new ConfigError(`unterminated ${q === "'" ? "single" : "double"} quote`, line);
    }
    let out = "";
    for (let i = 1; i < text.length - 1; i++) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length - 1) {
        out += text[i + 1];
        i++;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  return text;
}

// parse returns the config object; nested maps hold only scalars.
export function parse(text) {
  if (typeof text !== "string") throw new ConfigError("config must be text");
  const lines = text.split(/\r?\n/);
  const root = {};
  let current = null; // the map an indented line goes into
  let currentKey = null;
  for (let n = 0; n < lines.length; n++) {
    const raw = stripComment(lines[n]);
    if (!raw.trim()) continue;
    const indent = raw.match(/^ */)[0].length;
    if (raw[indent] === "\t") throw new ConfigError("tabs are not allowed for indentation", n + 1);
    if (indent > 4) throw new ConfigError("too much indentation (one nested level, 2 spaces)", n + 1);
    const line = raw.trim();
    // [\s\S] for the value: a lone \r must reach validation (rejected
    // there), and JS's dot does not match \r
    const m = /^([^\s:][^:]*):(?:[ ]+([\s\S]*))?$/.exec(line);
    if (!m) throw new ConfigError(`expected "key: value"`, n + 1);
    const key = m[1].trim();
    if (!key) throw new ConfigError("empty key", n + 1);
    const value = m[2] === undefined ? null : m[2].trim();
    if (indent === 0) {
      if (value === null || value === "") {
        // start of a nested map (or an empty one)
        current = {};
        currentKey = key;
        root[key] = current;
      } else {
        current = null;
        currentKey = null;
        root[key] = parseScalar(value, n + 1);
      }
    } else {
      if (!current) throw new ConfigError(`indented line under "${currentKey ?? "?"}" which is not a map`, n + 1);
      if (value === null || value === "") throw new ConfigError(`"${key}" has no value (nested maps of maps are not supported)`, n + 1);
      if (key in current) throw new ConfigError(`duplicate key "${key}"`, n + 1);
      current[key] = parseScalar(value, n + 1);
    }
  }
  return root;
}
