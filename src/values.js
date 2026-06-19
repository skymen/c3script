// Runtime value wrappers. Primitive script values (number, string, bool, null)
// and arrays are represented by their native JS counterparts. Script objects
// ("maps") use a JS Map. Everything else is one of the classes below.

// A user-defined function with captured scope. `homeClass` is set for class
// methods/constructors so `super` can resolve relative to the defining class.
export class Closure {
  constructor(params, body, env, name = null, homeClass = null) {
    this.params = params;
    this.body = body; // BlockStmt
    this.env = env;
    this.name = name;
    this.homeClass = homeClass;
  }
}

// Wraps a host (JS) function so it can be called from scripts. `raw` builtins
// receive/return script values directly (no host marshalling); non-raw host
// functions have their args marshalled to JS and return values back.
export class NativeFn {
  constructor(fn, name = "native", receiver = undefined, raw = false) {
    this.fn = fn;
    this.name = name;
    this.receiver = receiver; // bound `this` for host method calls
    this.raw = raw;
  }
}

// A user-defined class. `parent` is the superclass (or null) for inheritance.
export class ClassValue {
  constructor(name, methods, ctor, parent = null) {
    this.name = name;
    this.methods = methods; // Map<string, Closure>
    this.ctor = ctor; // Closure | null
    this.parent = parent; // ClassValue | null
  }
}

// An instance of a ClassValue.
export class Instance {
  constructor(klass) {
    this.klass = klass;
    this.fields = new Map();
  }
}

// Live bridge to a host JS object/array. Member access reads/writes the
// underlying object directly so scripts always see current host state.
// `policy` controls whether scripts may modify ({writable}) or add new keys
// ({extensible}); it propagates to nested host objects.
export class HostObject {
  constructor(obj, policy = { writable: true, extensible: true }) {
    this.obj = obj;
    this.policy = policy;
  }
}

// ---- helpers shared across the runtime ----

export function isCallable(v) {
  return v instanceof Closure || v instanceof NativeFn;
}

// JS-like, simplified truthiness: null / false / 0 / "" / empty are falsy.
export function isTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  return true;
}

export function typeName(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "object";
  if (v instanceof Closure || v instanceof NativeFn) return "function";
  if (v instanceof ClassValue) return "class";
  if (v instanceof Instance) return "instance";
  if (v instanceof HostObject) return "object";
  if (v instanceof Promise) return "promise";
  return "unknown";
}

// Render a script value as a string (used by print / string concat). Cyclic
// arrays/objects render as [...] / {...} instead of overflowing the stack.
export function stringify(v, seen = new Set()) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) return "[...]";
    seen.add(v);
    const r = "[" + v.map((x) => stringify(x, seen)).join(", ") + "]";
    seen.delete(v);
    return r;
  }
  if (v instanceof Map) {
    if (seen.has(v)) return "{...}";
    seen.add(v);
    const parts = [];
    for (const [k, val] of v) parts.push(`${k}: ${stringify(val, seen)}`);
    seen.delete(v);
    return "{" + parts.join(", ") + "}";
  }
  if (v instanceof Closure) return `<function ${v.name || "anonymous"}>`;
  if (v instanceof NativeFn) return `<native ${v.name}>`;
  if (v instanceof ClassValue) return `<class ${v.name}>`;
  if (v instanceof Instance) return `<${v.klass.name} instance>`;
  if (v instanceof HostObject) return stringifyHost(v.obj);
  if (v instanceof Promise) return "<promise>";
  return String(v);
}

function stringifyHost(obj) {
  if (Array.isArray(obj)) return "[" + obj.map((x) => stringify(x)).join(", ") + "]";
  if (typeof obj === "function") return "<native function>";
  if (obj && typeof obj === "object") {
    const parts = [];
    for (const k of Object.keys(obj)) parts.push(`${k}: ...`);
    return "{" + parts.join(", ") + "}";
  }
  return String(obj);
}
