// @magpie-community/custom-headers — engine entry.
// The injection channel (gateway middleware / hooks / provider fetch) is a
// thin adapter on top of resolveHeaders(); it is wired once magpie's
// request-level header extension point lands (see FEASIBILITY.md).

export { resolveHeaders } from "./lib/inject.mjs";
export { load, findConfig, validate, clearConfigCache, CONFIG_NAME } from "./lib/config.mjs";
export { evaluate, validate as validateExpression, refs, splitTop, scanOuter, scanInner } from "./lib/expression.mjs";
export { makeResolver, clearContextCache, stripCredentials, KNOWN } from "./lib/context.mjs";
export { applyPolicy, mergeValues } from "./lib/policy.mjs";
export { parse as parseYAML, parseScalar, ConfigError } from "./lib/yaml.mjs";
