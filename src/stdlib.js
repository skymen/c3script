// Tiny, host-independent built-ins. Installed as "raw" NativeFns (they receive
// and return script values directly, with no host marshalling). Opt-in via the
// public API. `print` output is overridable for tests and custom hosts.

import { NativeFn, stringify, typeName, isTruthy, HostObject, isPrivateKey } from "./values.js";
import { LangError } from "./errors.js";

// Single source of truth for the bare, un-namespaced global verbs. These stay
// un-namespaced because they read naturally as plain calls and depend on
// language internals (raw script values, stringify, lengthOf, …). Namespaced
// modules (Math, Easing, …) are plain host objects installed separately via
// Interpreter.installModules — see examples/stdlib-modules.mjs. The editor's
// BUILTINS list is derived from this array so the two can never drift.
export const CORE_GLOBAL_NAMES = [
  "print",
  "log",
  "len",
  "keys",
  "str",
  "num",
  "bool",
  "range",
  "sleep",
  "waitAll",
  "defer",
];

function lengthOf(x) {
  if (Array.isArray(x) || typeof x === "string") return x.length;
  if (x instanceof Map) return x.size;
  if (x instanceof HostObject) {
    return Array.isArray(x.obj)
      ? x.obj.length
      : Object.keys(x.obj).filter((k) => !isPrivateKey(k)).length;
  }
  throw new Error(`len() expects array, string, or object, got ${typeName(x)}`);
}

function keysOf(x) {
  if (x instanceof Map) return [...x.keys()];
  if (x instanceof HostObject && x.obj && typeof x.obj === "object") {
    return Object.keys(x.obj).filter((k) => !isPrivateKey(k)); // hide __ metadata
  }
  throw new Error(`keys() expects an object, got ${typeName(x)}`);
}

function makeRange(a, b, step) {
  let start, end, st;
  if (b === undefined || b === null) { start = 0; end = a; st = 1; }
  else { start = a; end = b; st = step == null ? 1 : step; }
  if (st === 0) throw new Error("range() step cannot be 0");
  const out = [];
  if (st > 0) for (let i = start; i < end; i += st) out.push(i);
  else for (let i = start; i > end; i += st) out.push(i);
  return out;
}

export function installCoreGlobals(env, { print } = {}) {
  const out = print || ((s) => console.log(s));
  const def = (name, fn) => env.define(name, new NativeFn(fn, name, undefined, true));

  // `log` is an alias of `print` — same underlying function.
  const printFn = (...args) => { out(args.map((a) => stringify(a)).join(" ")); return null; };
  def("print", printFn);
  def("log", printFn);
  def("len", (x) => lengthOf(x));
  def("keys", (x) => keysOf(x));
  def("str", (x) => stringify(x));
  def("num", (x) => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isNaN(n) ? null : n;
  });
  def("bool", (x) => isTruthy(x));
  def("range", (a, b, step) => makeRange(a, b, step));

  // Async helpers. These return raw JS promises; scripts consume them with
  // `await` (the host then awaits the Promise run()/call() returns). Raw builtins
  // skip marshalling, so the promise reaches the script as an awaitable value.
  def("sleep", (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : ms)));
  def("waitAll", (arr) => {
    if (!Array.isArray(arr)) throw new Error(`waitAll() expects an array, got ${typeName(arr)}`);
    return Promise.all(arr.map((x) => Promise.resolve(x)));
  });
  // A script-controllable promise (like JS Promise.withResolvers). Returns a
  // script object { promise, resolve(v), reject(e) }; await `promise` and settle
  // it later from a separate event handler. All three are raw so the resolved
  // value is marshalled exactly once, on resume, by continueAsync.
  def("defer", () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {}); // mark handled: an un-awaited reject must not leak as
                             // a host-process unhandledRejection; real awaiters
                             // still observe settlement via their own await.
    const obj = new Map();
    obj.set("promise", promise);
    obj.set("resolve", new NativeFn((v = null) => { resolve(v); return null; }, "resolve", undefined, true));
    obj.set("reject", new NativeFn((e = null) => {
      reject(e instanceof LangError ? e : new LangError(stringify(e), { phase: "runtime" }));
      return null;
    }, "reject", undefined, true));
    return obj;
  });

  return env;
}
