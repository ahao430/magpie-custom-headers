// The one entry point an injection channel needs: given the request's
// working directory (and whatever agent/session identity the channel has),
// produce the headers to set. Never throws — a broken config or a failing
// variable degrades to "no headers" plus diagnostics, never a failed
// request (PLAN §13).

import { load, ConfigError } from "./config.mjs";
import { makeResolver } from "./context.mjs";
import { evaluate } from "./expression.mjs";
import { applyPolicy } from "./policy.mjs";

// resolveHeaders returns { set: [[name, value]], notes: [string] }.
// `existing` is the request's current headers (Headers or plain object),
// only read by the preserve/merge policies.
export function resolveHeaders({ cwd, agent, session, existing, log } = {}) {
  const notes = [];
  const out = { set: [], notes };
  try {
    const found = load(cwd);
    if (!found) return out;
    const { config } = found;
    if (!config.enabled) return out;
    const resolve = makeResolver({ cwd, agent, session, projectName: config.projectName, log: (m) => notes.push(m) });
    const entries = [];
    for (const [name, expr] of Object.entries(config.headers)) {
      const result = evaluate(expr, resolve);
      if (!result.ok) {
        notes.push(`${name}: ${result.tried?.length ? `missing ${result.tried.join(", ")}` : result.reason}`);
      }
      entries.push({ name, ok: result.ok, value: result.value });
    }
    out.set = applyPolicy({ config, entries, existing }).filter(([name, value]) => {
      // last line of defence: a variable that somehow carried a control
      // character must not reach the wire (PLAN §9.1)
      if (/[\r\n\0]/.test(value)) {
        notes.push(`${name}: computed value has a control character, dropped`);
        return false;
      }
      return true;
    });
  } catch (e) {
    const detail = e instanceof ConfigError ? `config error: ${e.message}` : `${e?.message ?? e}`;
    notes.push(`skipped: ${detail}`);
    out.set = [];
  }
  return out;
}
