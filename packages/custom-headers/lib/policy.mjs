// Header policy engine (PLAN §6): turns evaluated entries into concrete
// set/remove actions against the request's existing headers.
//
//   conflictPolicy  preserve | override | merge   (value computed fine)
//   onMissing       omit | empty | fallback       (every term failed)
//
// Notes carried over from Phase 0: channels can only *set* outgoing
// headers, so `omit` means "never set" here; requests build their header
// set fresh, so there is no stale value from a previous request to clean.

export function applyPolicy({ config, entries, existing } = {}) {
  const set = [];
  const policy = config?.conflictPolicy ?? "override";
  const sep = config?.mergeSeparator ?? ",";
  const unique = config?.mergeUnique ?? true;
  const existingValue = (name) => {
    if (!existing) return undefined;
    if (typeof existing.get === "function") return existing.get(name); // Headers
    // plain objects: header keys may be cased either way (HTTP/2 senders
    // lowercase everything), so match case-insensitively
    const lower = name.toLowerCase();
    for (const k of Object.keys(existing)) if (k.toLowerCase() === lower) return existing[k];
    return undefined;
  };
  for (const entry of entries) {
    const name = entry.name;
    if (entry.ok) {
      const current = existingValue(name);
      if (policy === "preserve" && current !== undefined && current !== "") continue;
      if (policy === "merge") {
        set.push([name, mergeValues(current, entry.value, sep, unique)]);
        continue;
      }
      set.push([name, entry.value]);
      continue;
    }
    // every term failed: the missing-value policy decides (PLAN §6.2)
    if (config?.onMissing === "empty") set.push([name, ""]);
    else if (config?.onMissing === "fallback") set.push([name, config.fallbackValue ?? ""]);
    // omit: nothing
  }
  return set;
}

// mergeValues joins the existing value (if any) and the computed one with
// sep; with unique, items are compared trimmed and case-insensitively and
// the first spelling wins. The computed value lands last.
export function mergeValues(current, next, sep, unique) {
  const parts = [];
  const push = (raw) => {
    for (const piece of String(raw).split(sep)) {
      const item = piece.trim();
      if (!item) continue;
      if (unique && parts.some((p) => p.toLowerCase() === item.toLowerCase())) continue;
      parts.push(item);
    }
  };
  if (current !== undefined && current !== "") push(current);
  push(next);
  return parts.join(sep);
}
