// Host-binding layer: the single, auditable boundary between script values and
// the JS host (the level editor). Globals registered here become reachable from
// scripts; nothing else is. Nested host objects are exposed via a live bridge
// (HostObject) so scripts always read/write current host state. A per-global
// policy controls whether scripts may modify or extend a host object.

import { NativeFn, Closure, ClassValue, Instance, HostObject } from "./values.js";
import { LangError } from "./errors.js";

const DEFAULT_POLICY = { writable: true, extensible: true };

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
// or values written into a host object).
export function scriptToHost(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (Array.isArray(v)) return v.map(scriptToHost);
  if (v instanceof HostObject) return v.obj;
  if (v instanceof Map) {
    const o = {};
    for (const [k, val] of v) o[k] = scriptToHost(val);
    return o;
  }
  if (v instanceof NativeFn) return v.fn;
  // Closure / ClassValue / Instance are opaque to the host; pass through.
  return v;
}

// Read a property from a live host object. Nested objects/arrays stay live and
// inherit the parent's policy. Functions become bound NativeFns so host-object
// method calls keep their `this`.
export function hostGet(host, key) {
  const target = host.obj;
  if (Array.isArray(target) && (key === "len" || key === "length")) {
    return target.length;
  }
  const val = target[key];
  if (typeof val === "function") return new NativeFn(val, String(key), target);
  if (val !== null && typeof val === "object" &&
      !(val instanceof HostObject) && !(val instanceof Map) &&
      !(val instanceof ClassValue) && !(val instanceof Instance) &&
      !(val instanceof Closure) && !(val instanceof NativeFn)) {
    return new HostObject(val, host.policy); // live + inherits policy
  }
  return hostToScript(val, host.policy);
}

// Write a property to a live host object, enforcing the object's policy and
// marshalling the value back to JS.
export function hostSet(host, key, value) {
  const p = host.policy || DEFAULT_POLICY;
  if (!p.writable) {
    throw new LangError(`cannot modify read-only object (property '${key}')`, { phase: "runtime" });
  }
  const exists = Array.isArray(host.obj)
    ? typeof key === "number" && key < host.obj.length
    : Object.prototype.hasOwnProperty.call(host.obj, key);
  if (!exists && !p.extensible) {
    throw new LangError(`cannot add new property '${key}' to a sealed object`, { phase: "runtime" });
  }
  host.obj[key] = scriptToHost(value);
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
