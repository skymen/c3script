// Host-binding layer: the single, auditable boundary between script values and
// the JS host (the level editor). Globals registered here become reachable from
// scripts; nothing else is. Nested host objects are exposed via a live bridge
// (HostObject) so scripts always read/write current host state. A per-global
// policy controls whether scripts may modify or extend a host object.

import { NativeFn, Closure, ClassValue, Instance, HostObject } from "./values.js";
import { LangError } from "./errors.js";

const DEFAULT_POLICY = { writable: true, extensible: true };

// Keys that would let a script climb the prototype chain to Object/Function or
// pollute prototypes. Never readable or writable through the bridge.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Convert a JS value coming from the host into a script value.
// Plain objects/arrays are wrapped as a live HostObject (not copied).
export function hostToScript(v, policy = DEFAULT_POLICY) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (t === "function") return new NativeFn(v, v.name || "native");
  // Already a runtime value? pass through unchanged.
  if (
    v instanceof Closure || v instanceof NativeFn || v instanceof ClassValue ||
    v instanceof Instance || v instanceof HostObject || v instanceof Map
  ) {
    return v;
  }
  if (Array.isArray(v) || t === "object") return new HostObject(v, policy);
  return v;
}

// Convert a script value into a plain JS value for the host (e.g. function args,
// or values written into a host object). Cyclic structures raise a clean error
// instead of overflowing the stack, and dangerous keys are never emitted.
export function scriptToHost(v, seen = new Set()) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (v instanceof HostObject) return v.obj;
  if (v instanceof NativeFn) return v.fn;
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new LangError("cannot pass a cyclic structure to the host", { phase: "runtime" });
    seen.add(v);
    const out = v.map((x) => scriptToHost(x, seen));
    seen.delete(v);
    return out;
  }
  if (v instanceof Map) {
    if (seen.has(v)) throw new LangError("cannot pass a cyclic structure to the host", { phase: "runtime" });
    seen.add(v);
    const o = {};
    for (const [k, val] of v) {
      if (DANGEROUS_KEYS.has(String(k))) continue; // never emit __proto__/constructor/prototype
      o[k] = scriptToHost(val, seen);
    }
    seen.delete(v);
    return o;
  }
  // Closure / ClassValue / Instance are opaque to the host; pass through.
  return v;
}

// Read a property from a live host object. SECURITY: only OWN properties are
// readable, and prototype-chain keys are blocked outright. This prevents a
// script from reaching `constructor`/`__proto__`/`prototype` (and from there
// Object/Function/globalThis) or inherited methods/getters on the host.
// Nested objects/arrays stay live and inherit the parent's policy. Own-property
// functions become bound NativeFns so host method calls keep their `this`.
export function hostGet(host, key) {
  const target = host.obj;
  const k = typeof key === "number" ? key : String(key);
  if (Array.isArray(target) && (k === "len" || k === "length")) {
    return target.length;
  }
  if (DANGEROUS_KEYS.has(k)) return null;
  if (target == null || !Object.hasOwn(target, k)) return null; // own properties only
  const val = target[k];
  if (typeof val === "function") return new NativeFn(val, k, target);
  if (val !== null && typeof val === "object" &&
      !(val instanceof HostObject) && !(val instanceof Map) &&
      !(val instanceof ClassValue) && !(val instanceof Instance) &&
      !(val instanceof Closure) && !(val instanceof NativeFn)) {
    return new HostObject(val, host.policy); // live + inherits policy
  }
  return hostToScript(val, host.policy);
}

// Write a property to a live host object, enforcing the object's policy and
// marshalling the value back to JS. SECURITY: prototype-chain keys are rejected
// so a script cannot set `__proto__` (prototype pollution) or `constructor`.
export function hostSet(host, key, value) {
  const k = typeof key === "number" ? key : String(key);
  if (DANGEROUS_KEYS.has(k)) {
    throw new LangError(`cannot set unsafe property '${k}'`, { phase: "runtime" });
  }
  const p = host.policy || DEFAULT_POLICY;
  if (!p.writable) {
    throw new LangError(`cannot modify read-only object (property '${k}')`, { phase: "runtime" });
  }
  const exists = Array.isArray(host.obj)
    ? typeof key === "number" && key < host.obj.length
    : Object.hasOwn(host.obj, k);
  if (!exists && !p.extensible) {
    throw new LangError(`cannot add new property '${k}' to a sealed object`, { phase: "runtime" });
  }
  host.obj[k] = scriptToHost(value);
  return value;
}

// Define a single global, optionally with a write policy for nested host state.
export function defineGlobal(env, name, value, { writable = true, extensible = true } = {}) {
  env.define(name, hostToScript(value, { writable, extensible }));
}

// Define many globals at once. The same policy applies to all of them.
export function defineGlobals(env, obj, options = {}) {
  for (const name of Object.keys(obj)) {
    defineGlobal(env, name, obj[name], options);
  }
}
