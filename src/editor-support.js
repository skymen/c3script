// Framework-agnostic helpers for building editor tooling (autocomplete,
// diagnostics) on top of c3script. No editor dependency — these return plain
// data, so a Monaco / CodeMirror / LSP front-end is a thin wrapper.

import { parse } from "./parser.js";

// Given the text BEFORE the cursor, determine the dotted path being completed.
//   "game.objects.pl"  -> { path: ["game","objects"], partial: "pl", isMember: true }
//   "game."            -> { path: ["game"],           partial: "",   isMember: true }
//   "ga"               -> { path: [],                 partial: "ga",  isMember: false }
export function completionPath(prefix) {
  const tail = (prefix.match(/[\w$.]*$/) || [""])[0];
  const parts = tail.split(".");
  const partial = parts.pop();
  return { path: parts, partial, isMember: tail.includes(".") };
}

// Walk a dotted path through a plain JS object graph. Returns the value, or the
// root object when the path is empty, or undefined if the path breaks.
export function resolvePathValue(root, path) {
  let v = root;
  for (const seg of path) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[seg];
  }
  return v;
}

// Describe the immediate members of a JS object for completion. Keys starting
// with "__" are treated as metadata and hidden.
export function describeObject(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .filter((k) => !k.startsWith("__"))
    .map((k) => {
      const v = obj[k];
      const kind =
        typeof v === "function" ? "function" :
        v && typeof v === "object" ? "object" : "value";
      return { name: k, kind, arity: typeof v === "function" ? v.length : undefined };
    });
}

// If the cursor sits inside a string literal that is an argument to a call,
// report the call's callee path and the argument index. Used to offer enum
// values for specific string arguments (e.g. game.on("<here>", ...)).
//   -> { callee, method, receiverPath, argIndex, inString: true } | null
export function callContextAt(text) {
  // Are we inside an unterminated string at the end of the prefix?
  const m = text.match(/(["'])(?:[^"'\\]|\\.)*$/);
  if (!m) return null;
  const before = text.slice(0, m.index);

  // Walk back to the "(" that opens this argument list, counting top-level commas.
  let depth = 0;
  let argIndex = 0;
  let i = before.length - 1;
  for (; i >= 0; i--) {
    const c = before[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "[" || c === "{") depth--;
    else if (c === "(") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      argIndex++;
    }
  }
  if (i < 0) return null;

  const calleeMatch = before.slice(0, i).match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
  if (!calleeMatch) return null;
  const callee = calleeMatch[0];
  const parts = callee.split(".");
  return {
    callee,
    method: parts[parts.length - 1],
    receiverPath: parts.slice(0, -1),
    argIndex,
    inString: true,
  };
}

// Resolve the enum values offered for a given call argument, from either a
// static schema or conventions on the receiver object:
//   - argEnums[callee][argIndex]
//   - receiver.__argEnums__[method][argIndex]
//   - receiver.__events__ for the common on(event, cb) pattern
export function enumValuesFor(ctx, { globals = {}, argEnums = {} } = {}) {
  const fromSchema = argEnums[ctx.callee];
  if (fromSchema && fromSchema[ctx.argIndex]) return fromSchema[ctx.argIndex];

  const receiver = resolvePathValue(globals, ctx.receiverPath);
  if (receiver && typeof receiver === "object") {
    const conv = receiver.__argEnums__ && receiver.__argEnums__[ctx.method];
    if (conv && conv[ctx.argIndex]) return conv[ctx.argIndex];
    if (ctx.method === "on" && ctx.argIndex === 0 && Array.isArray(receiver.__events__)) {
      return receiver.__events__;
    }
  }
  return null;
}

// Top-level symbols the user has declared, so completion can offer them too.
// Returns [] if the source doesn't parse.
export function collectScriptSymbols(source) {
  try {
    const ast = parse(source);
    const out = [];
    for (const s of ast.body) {
      if (s.type === "VarDecl") out.push({ name: s.name, kind: "variable" });
      else if (s.type === "FunctionDecl") out.push({ name: s.name, kind: "function" });
      else if (s.type === "ClassDecl") out.push({ name: s.name, kind: "class" });
    }
    return out;
  } catch {
    return [];
  }
}

// The built-in (stdlib) function names, for top-level completion.
export const BUILTINS = [
  "print", "len", "keys", "type", "str", "num", "bool", "range",
  "abs", "floor", "ceil", "round", "sqrt", "min", "max", "pow",
];
