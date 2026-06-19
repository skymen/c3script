// Tiny, host-independent built-ins. Installed as "raw" NativeFns (they receive
// and return script values directly, with no host marshalling). Opt-in via the
// public API. `print` output is overridable for tests and custom hosts.

import { NativeFn, stringify, typeName, isTruthy, HostObject } from "./values.js";

function lengthOf(x) {
  if (Array.isArray(x) || typeof x === "string") return x.length;
  if (x instanceof Map) return x.size;
  if (x instanceof HostObject) {
    return Array.isArray(x.obj) ? x.obj.length : Object.keys(x.obj).length;
  }
  throw new Error(`len() expects array, string, or object, got ${typeName(x)}`);
}

function keysOf(x) {
  if (x instanceof Map) return [...x.keys()];
  if (x instanceof HostObject && x.obj && typeof x.obj === "object") {
    return Object.keys(x.obj);
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

export function installStdlib(env, { print } = {}) {
  const out = print || ((s) => console.log(s));
  const def = (name, fn) => env.define(name, new NativeFn(fn, name, undefined, true));

  def("print", (...args) => { out(args.map(stringify).join(" ")); return null; });
  def("len", (x) => lengthOf(x));
  def("keys", (x) => keysOf(x));
  def("type", (x) => typeName(x));
  def("str", (x) => stringify(x));
  def("num", (x) => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isNaN(n) ? null : n;
  });
  def("bool", (x) => isTruthy(x));
  def("range", (a, b, step) => makeRange(a, b, step));

  // Math
  def("abs", (x) => Math.abs(x));
  def("floor", (x) => Math.floor(x));
  def("ceil", (x) => Math.ceil(x));
  def("round", (x) => Math.round(x));
  def("sqrt", (x) => Math.sqrt(x));
  def("min", (...a) => Math.min(...a));
  def("max", (...a) => Math.max(...a));
  def("pow", (a, b) => Math.pow(a, b));

  return env;
}
