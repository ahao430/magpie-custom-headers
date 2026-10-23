// The expression engine: fixed strings, ${...} variables, `||` fallbacks
// and mixed templates (PLAN §5). No eval, no Function, no arbitrary code —
// the grammar below is the whole language.
//
//   expr  := term ("||" term)*
//   term  := ( ${group} | 'quoted' | "quoted" | char )*
//   group := inner ("||" inner)*            // inside ${...}: bare refs
//   inner := ( ref | 'quoted' | "quoted" | char )*
//   ref   := namespace.property             // letters, digits, _
//
// Outside, variables are wrapped: ${git.branch}. Inside a group they are
// bare — that is what the canonical fallback is made of:
//   ${package.name || project.name || 'unknown'}
// A term succeeds when every variable in it resolves to a value that is
// not empty and not whitespace-only (PLAN §5.2); its result is the chunks
// concatenated. The first succeeding term wins; if none do, the caller
// applies the onMissing policy. ${...} may not nest. Quoted stretches are
// literal text: they protect `||` and spaces, and honour \' \" \\ escapes.

const REF = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const IDENT = /[A-Za-z_][A-Za-z0-9_.]*/y; // dotted identifier scan (sticky)

// splitTop divides expr on top-level `||` — respected inside quotes, inside
// ${...}, and after escapes inside quotes.
export function splitTop(expr) {
  const terms = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    const next = expr[i + 1];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < expr.length) {
        cur += expr[i + 1];
        i++;
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "$" && next === "{") {
      depth++;
      cur += "${";
      i++;
      continue;
    }
    if (c === "}" && depth > 0) {
      depth--;
      cur += c;
      continue;
    }
    if (c === "|" && next === "|" && depth === 0) {
      terms.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  if (quote) throw new Error(`unterminated ${quote === "'" ? "single" : "double"} quote`);
  if (depth > 0) throw new Error(`unclosed "\${"`);
  terms.push(cur);
  return terms;
}

// readQuoted reads the quoted stretch opening at i; returns [body, next].
function readQuoted(term, i) {
  const q = term[i];
  let body = "";
  let j = i + 1;
  for (; j < term.length; j++) {
    const c = term[j];
    if (c === "\\" && j + 1 < term.length) {
      body += term[j + 1];
      j++;
      continue;
    }
    if (c === q) return [body, j + 1];
    body += c;
  }
  throw new Error(`unterminated ${q === "'" ? "single" : "double"} quote`);
}

// findGroupEnd: the index of the } closing the ${...} whose content starts
// at `start`. Braces may not nest; quotes inside are fine.
function findGroupEnd(term, start) {
  let quote = "";
  for (let j = start; j < term.length; j++) {
    const c = term[j];
    if (quote) {
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "$" && term[j + 1] === "{") throw new Error(`nested "\${" is not supported`);
    if (c === "}") return j;
  }
  throw new Error(`unclosed "\${"`);
}

// scanInner breaks one group term into chunks: {ref} | {text}. Bare
// dotted identifiers are refs here; a token that only looks like one
// (starts with a digit) stays text.
export function scanInner(term) {
  const chunks = [];
  let text = "";
  let i = 0;
  while (i < term.length) {
    const c = term[i];
    if (c === "'" || c === '"') {
      const [body, next] = readQuoted(term, i);
      text += body;
      i = next;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(term);
      const token = m ? m[0] : c;
      if (REF.test(token)) {
        if (text) {
          chunks.push({ text });
          text = "";
        }
        chunks.push({ ref: token });
      } else {
        text += token;
      }
      i += token.length;
      continue;
    }
    text += c;
    i++;
  }
  if (text) chunks.push({ text });
  return chunks;
}

// scanOuter breaks one top-level term into chunks: {text} | {group}.
export function scanOuter(term) {
  const chunks = [];
  let text = "";
  let i = 0;
  while (i < term.length) {
    const c = term[i];
    if (c === "'" || c === '"') {
      const [body, next] = readQuoted(term, i);
      text += body;
      i = next;
      continue;
    }
    if (c === "$" && term[i + 1] === "{") {
      const end = findGroupEnd(term, i + 2);
      if (text) {
        chunks.push({ text });
        text = "";
      }
      chunks.push({ group: term.slice(i + 2, end) });
      i = end + 1;
      continue;
    }
    text += c;
    i++;
  }
  if (text) chunks.push({ text });
  return chunks;
}

// refs lists every variable an expression mentions, groups included.
export function refs(expr) {
  const out = [];
  for (const term of splitTop(expr)) {
    for (const chunk of scanOuter(term.trim())) {
      if (chunk.group) {
        for (const inner of splitTop(chunk.group)) {
          for (const c of scanInner(inner.trim())) if (c.ref) out.push(c.ref);
        }
      }
    }
  }
  return out;
}

// validate throws a descriptive error when the expression cannot be parsed.
export function validate(expr) {
  if (typeof expr !== "string") throw new Error("expression must be a string");
  const terms = splitTop(expr);
  for (let i = 0; i < terms.length; i++) {
    if (terms[i].trim() === "") {
      const problem = terms.length === 1 ? "empty expression" : i === 0 ? "starts with ||" : i === terms.length - 1 ? "ends with ||" : "has an empty || operand";
      throw new Error(problem);
    }
    for (const chunk of scanOuter(terms[i].trim())) {
      if (chunk.group === undefined) continue; // "" is a group, too: ${}
      const content = chunk.group;
      const innerTerms = splitTop(content);
      let sawRef = false;
      for (let k = 0; k < innerTerms.length; k++) {
        if (innerTerms[k].trim() === "") {
          throw new Error(`empty operand in \${${content}}`);
        }
        for (const inner of scanInner(innerTerms[k].trim())) {
          if (inner.ref) sawRef = true;
        }
      }
      // a group with no variable in it is a mistake the user should hear
      // about, not literal text coming out of the braces (PLAN §5.5)
      if (!sawRef) throw new Error(`no variable in "\${${content}}"`);
    }
  }
}

const useful = (v) => typeof v === "string" && v.trim() !== "";

// evalFallback evaluates one `||` list; resolve(ref) -> {ok, value} | {ok:false}.
function evalFallback(text, scan, resolve) {
  const tried = [];
  for (const raw of splitTop(text)) {
    const chunks = scan(raw.trim());
    let value = "";
    let failed = null;
    for (const chunk of chunks) {
      if (chunk.text !== undefined) {
        value += chunk.text;
        continue;
      }
      if (chunk.group) {
        const inner = evalFallback(chunk.group, scanInner, resolve);
        if (!inner.ok) {
          failed = inner.tried.join(", ") || "(group)";
          break;
        }
        value += inner.value;
        continue;
      }
      const r = resolve(chunk.ref);
      if (r && r.ok && useful(r.value)) {
        value += r.value;
      } else {
        failed = chunk.ref;
        break;
      }
    }
    if (failed === null && useful(value)) return { ok: true, value };
    tried.push(failed ?? "(empty)");
  }
  return { ok: false, tried };
}

// evaluate returns { ok, value } on success or { ok: false, reason, tried }
// when every term failed.
export function evaluate(expr, resolve) {
  const top = evalFallback(expr, scanOuter, resolve);
  if (top.ok) return { ok: true, value: top.value };
  return { ok: false, reason: "no term resolved", tried: top.tried };
}
