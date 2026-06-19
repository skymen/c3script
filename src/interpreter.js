// Generator-based tree-walking evaluator. Every statement yields a checkpoint
// ({ line, kind, env }) before it runs, so a driver can count steps (fuel),
// pause, single-step, or hit breakpoints. Expressions return values via the
// generator's `return`. Control flow (return/break/continue) uses internal
// signal exceptions that propagate cleanly through `yield*` delegation.

import {
  Closure, NativeFn, ClassValue, Instance, HostObject,
  isTruthy, typeName, stringify,
} from "./values.js";
import { hostGet, hostSet, scriptToHost, hostToScript } from "./host.js";
import { LangError } from "./errors.js";

// ---- internal control-flow signals (not LangErrors) ----
class ReturnSignal {
  constructor(value) { this.value = value; }
}
class BreakSignal {}
class ContinueSignal {}

// Symbol key for the per-method super-context binding. Using a Symbol (not a
// string) means scripts cannot name or read it via an identifier.
const SUPER = Symbol("superctx");

function valuesEqual(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

export class Evaluator {
  constructor() {
    this.maxSteps = 1_000_000;
    this.onStep = null;
    this.steps = 0;
    this.callStack = [];
  }

  reset({ maxSteps = 1_000_000, onStep = null } = {}) {
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.steps = 0;
    this.callStack = [];
    return this;
  }

  stackTrace() {
    return this.callStack.slice().reverse();
  }

  runtimeError(message, line) {
    return new LangError(message, { line, phase: "runtime", stack: this.stackTrace() });
  }

  // Count a step and enforce the fuel limit. Called by drivers (run + debugger)
  // at each yielded checkpoint.
  stepCheck(checkpoint) {
    this.steps++;
    if (this.maxSteps && this.steps > this.maxSteps) {
      throw this.runtimeError(
        `step limit exceeded (${this.maxSteps}) — possible infinite loop`,
        checkpoint && checkpoint.line,
      );
    }
    if (this.onStep) this.onStep(checkpoint);
  }

  // Drive a generator to completion (normal run; no pausing). A JS stack
  // overflow (runaway recursion / huge structure) is converted to a clean error.
  drive(gen) {
    try {
      let res = gen.next();
      while (!res.done) {
        this.stepCheck(res.value);
        res = gen.next();
      }
      return res.value;
    } catch (e) {
      if (e instanceof RangeError) {
        throw this.runtimeError("call stack exhausted (too much recursion)", null);
      }
      throw e;
    }
  }

  // ---- statements ----

  *execProgram(program, env) {
    try {
      yield* this.execStatements(program.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof BreakSignal || e instanceof ContinueSignal) {
        throw this.runtimeError("'break'/'continue' used outside of a loop", null);
      }
      throw e;
    }
    return null;
  }

  *execStatements(list, env) {
    for (const stmt of list) yield* this.execStmt(stmt, env);
  }

  *execStmt(stmt, env) {
    yield { line: stmt.line, kind: stmt.type, env };

    switch (stmt.type) {
      case "VarDecl": {
        const value = stmt.init ? yield* this.evalExpr(stmt.init, env) : null;
        env.define(stmt.name, value, stmt.kind === "const");
        return;
      }
      case "FunctionDecl": {
        env.define(stmt.name, new Closure(stmt.params, stmt.body, env, stmt.name));
        return;
      }
      case "ClassDecl": {
        let parent = null;
        if (stmt.superClass) {
          parent = yield* this.evalExpr(stmt.superClass, env);
          if (!(parent instanceof ClassValue)) {
            throw this.runtimeError(`class '${stmt.name}' cannot extend a non-class`, stmt.line);
          }
        }
        env.define(stmt.name, this.makeClass(stmt, env, parent));
        return;
      }
      case "ReturnStmt": {
        const value = stmt.argument ? yield* this.evalExpr(stmt.argument, env) : null;
        throw new ReturnSignal(value);
      }
      case "IfStmt": {
        if (isTruthy(yield* this.evalExpr(stmt.test, env))) {
          yield* this.execStmt(stmt.consequent, env);
        } else if (stmt.alternate) {
          yield* this.execStmt(stmt.alternate, env);
        }
        return;
      }
      case "WhileStmt": {
        while (isTruthy(yield* this.evalExpr(stmt.test, env))) {
          try {
            yield* this.execStmt(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "ForStmt": {
        const scope = env.child();
        if (stmt.init) yield* this.execStmt(stmt.init, scope);
        while (stmt.test === null || isTruthy(yield* this.evalExpr(stmt.test, scope))) {
          try {
            yield* this.execStmt(stmt.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) {
              // fall through to update
            } else {
              throw e;
            }
          }
          if (stmt.update) yield* this.evalExpr(stmt.update, scope);
        }
        return;
      }
      case "ForOfStmt": {
        const iterable = yield* this.evalExpr(stmt.iterable, env);
        const items = this.toIterable(iterable, stmt.line);
        const scope = env.child();
        for (const item of items) {
          scope.define(stmt.name, item, stmt.kind === "const");
          try {
            yield* this.execStmt(stmt.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "BreakStmt":
        throw new BreakSignal();
      case "ContinueStmt":
        throw new ContinueSignal();
      case "BlockStmt": {
        yield* this.execStatements(stmt.body, env.child());
        return;
      }
      case "ExprStmt": {
        yield* this.evalExpr(stmt.expression, env);
        return;
      }
      default:
        throw this.runtimeError(`cannot execute statement '${stmt.type}'`, stmt.line);
    }
  }

  makeClass(stmt, env, parent = null) {
    const methods = new Map();
    const klass = new ClassValue(stmt.name, methods, null, parent);
    for (const m of stmt.members) {
      const closure = new Closure(m.params, m.body, env, `${stmt.name}.${m.name}`, klass);
      if (m.isCtor) klass.ctor = closure;
      else methods.set(m.name, closure);
    }
    return klass;
  }

  // Walk the inheritance chain for a method / constructor.
  findMethod(klass, name) {
    for (let k = klass; k; k = k.parent) {
      if (k.methods.has(name)) return k.methods.get(name);
    }
    return null;
  }

  findConstructor(klass) {
    for (let k = klass; k; k = k.parent) {
      if (k.ctor) return k.ctor;
    }
    return null;
  }

  // ---- expressions (return a value) ----

  *evalExpr(node, env) {
    switch (node.type) {
      case "NumberLit":
      case "StringLit":
      case "BoolLit":
        return node.value;
      case "NullLit":
        return null;
      case "Identifier":
        return env.get(node.name, node.line);
      case "ThisExpr":
        return env.get("this", node.line);

      case "ArrayLit": {
        const arr = [];
        for (const el of node.elements) arr.push(yield* this.evalExpr(el, env));
        return arr;
      }
      case "ObjectLit": {
        const map = new Map();
        for (const p of node.properties) map.set(p.key, yield* this.evalExpr(p.value, env));
        return map;
      }
      case "FunctionExpr": {
        if (node.name) {
          const scope = env.child();
          const fn = new Closure(node.params, node.body, scope, node.name);
          scope.define(node.name, fn, true);
          return fn;
        }
        return new Closure(node.params, node.body, env, null);
      }

      case "Unary": {
        const v = yield* this.evalExpr(node.argument, env);
        if (node.op === "!") return !isTruthy(v);
        if (node.op === "-") {
          if (typeof v !== "number") {
            throw this.runtimeError(`cannot negate ${typeName(v)}`, node.line);
          }
          return -v;
        }
        throw this.runtimeError(`unknown unary operator '${node.op}'`, node.line);
      }

      case "Binary": {
        const l = yield* this.evalExpr(node.left, env);
        const r = yield* this.evalExpr(node.right, env);
        return this.applyBinary(node.op, l, r, node.line);
      }

      case "Logical": {
        const l = yield* this.evalExpr(node.left, env);
        if (node.op === "&&") return isTruthy(l) ? yield* this.evalExpr(node.right, env) : l;
        return isTruthy(l) ? l : yield* this.evalExpr(node.right, env); // ||
      }

      case "Ternary": {
        const test = yield* this.evalExpr(node.test, env);
        return isTruthy(test)
          ? yield* this.evalExpr(node.consequent, env)
          : yield* this.evalExpr(node.alternate, env);
      }

      case "Assign":
        return yield* this.evalAssign(node, env);

      case "Member": {
        if (node.object.type === "SuperExpr") {
          const ctx = this.superContext(env, node.line);
          const method = this.findMethod(ctx.parentClass, node.property);
          if (!method) throw this.runtimeError(`'super' has no method '${node.property}'`, node.line);
          return this.bindThis(method, ctx.instance);
        }
        const obj = yield* this.evalExpr(node.object, env);
        return this.getMember(obj, node.property, node.line);
      }
      case "Index": {
        const obj = yield* this.evalExpr(node.object, env);
        const idx = yield* this.evalExpr(node.index, env);
        return this.getIndex(obj, idx, node.line);
      }

      case "Call": {
        // super(...) — delegate to the parent constructor on the same instance.
        if (node.callee.type === "SuperExpr") {
          const ctx = this.superContext(env, node.line);
          const args = [];
          for (const a of node.args) args.push(yield* this.evalExpr(a, env));
          const ctor = this.findConstructor(ctx.parentClass);
          if (ctor) yield* this.callValue(this.bindThis(ctor, ctx.instance), args, node.line);
          return null;
        }
        const fn = yield* this.evalExpr(node.callee, env);
        const args = [];
        for (const a of node.args) args.push(yield* this.evalExpr(a, env));
        return yield* this.callValue(fn, args, node.line);
      }

      case "SuperExpr":
        throw this.runtimeError("'super' must be used as super(...) or super.method(...)", node.line);

      case "NewExpr": {
        const klass = yield* this.evalExpr(node.callee, env);
        if (!(klass instanceof ClassValue)) {
          throw this.runtimeError(`'new' requires a class, got ${typeName(klass)}`, node.line);
        }
        const inst = new Instance(klass);
        const args = [];
        for (const a of node.args) args.push(yield* this.evalExpr(a, env));
        const ctor = this.findConstructor(klass);
        if (ctor) {
          yield* this.callValue(this.bindThis(ctor, inst), args, node.line);
        }
        return inst;
      }

      default:
        throw this.runtimeError(`cannot evaluate expression '${node.type}'`, node.line);
    }
  }

  *evalAssign(node, env) {
    const rhs = yield* this.evalExpr(node.value, env);
    const t = node.target;
    const compound = node.op !== "=";
    const combine = (cur) => this.applyBinary(node.op[0], cur, rhs, node.line);

    if (t.type === "Identifier") {
      const value = compound ? combine(env.get(t.name, node.line)) : rhs;
      env.assign(t.name, value, node.line);
      return value;
    }
    if (t.type === "Member") {
      const obj = yield* this.evalExpr(t.object, env);
      const value = compound ? combine(this.getMember(obj, t.property, node.line)) : rhs;
      this.setMember(obj, t.property, value, node.line);
      return value;
    }
    if (t.type === "Index") {
      const obj = yield* this.evalExpr(t.object, env);
      const idx = yield* this.evalExpr(t.index, env);
      const value = compound ? combine(this.getIndex(obj, idx, node.line)) : rhs;
      this.setIndex(obj, idx, value, node.line);
      return value;
    }
    throw this.runtimeError("invalid assignment target", node.line);
  }

  // ---- calling ----

  *callValue(fn, args, line) {
    if (fn instanceof NativeFn) {
      const callArgs = fn.raw ? args : args.map((a) => scriptToHost(a));
      let result;
      try {
        result = fn.fn.apply(fn.receiver, callArgs);
      } catch (e) {
        if (e instanceof LangError) throw e;
        throw this.runtimeError(`host function '${fn.name}' threw: ${e.message}`, line);
      }
      return fn.raw ? result : hostToScript(result);
    }

    if (fn instanceof Closure) {
      const scope = fn.env.child();
      for (let i = 0; i < fn.params.length; i++) {
        scope.define(fn.params[i], i < args.length ? args[i] : null);
      }
      this.callStack.push({ name: fn.name || "anonymous", line });
      try {
        yield* this.execStatements(fn.body.body, scope);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        // Attach the script call stack at the innermost frame, before it unwinds.
        if (e instanceof LangError && !e.scriptStack) e.scriptStack = this.stackTrace();
        throw e;
      } finally {
        this.callStack.pop();
      }
      return null;
    }

    throw this.runtimeError(`value of type ${typeName(fn)} is not callable`, line);
  }

  bindThis(closure, thisVal) {
    const scope = closure.env.child();
    scope.define("this", thisVal, true);
    // Super resolves relative to the class that defined this method. Stored under
    // a Symbol so scripts can't reach it by name.
    const parentClass = closure.homeClass ? closure.homeClass.parent : null;
    scope.vars.set(SUPER, { parentClass, instance: thisVal });
    return new Closure(closure.params, closure.body, scope, closure.name, closure.homeClass);
  }

  superContext(env, line) {
    let ctx = null;
    for (let e = env; e; e = e.parent) {
      if (e.vars.has(SUPER)) { ctx = e.vars.get(SUPER); break; }
    }
    if (!ctx || !ctx.parentClass) {
      throw this.runtimeError("'super' used where there is no superclass", line);
    }
    return ctx;
  }

  // ---- member / index access ----

  getMember(obj, name, line) {
    if (obj instanceof Instance) {
      if (obj.fields.has(name)) return obj.fields.get(name);
      const method = this.findMethod(obj.klass, name);
      if (method) return this.bindThis(method, obj);
      return null;
    }
    if (obj instanceof Map) {
      return obj.has(name) ? obj.get(name) : null;
    }
    if (obj instanceof HostObject) {
      return hostGet(obj, name);
    }
    if (Array.isArray(obj)) return this.arrayMember(obj, name, line);
    if (typeof obj === "string") return this.stringMember(obj, name, line);
    throw this.runtimeError(`cannot read property '${name}' of ${typeName(obj)}`, line);
  }

  setMember(obj, name, value, line) {
    if (obj instanceof Instance) return void obj.fields.set(name, value);
    if (obj instanceof Map) return void obj.set(name, value);
    if (obj instanceof HostObject) return void hostSet(obj, name, value);
    throw this.runtimeError(`cannot set property '${name}' on ${typeName(obj)}`, line);
  }

  getIndex(obj, idx, line) {
    if (Array.isArray(obj)) {
      const i = this.intIndex(idx, line);
      return i >= 0 && i < obj.length ? obj[i] : null;
    }
    if (typeof obj === "string") {
      const i = this.intIndex(idx, line);
      return i >= 0 && i < obj.length ? obj[i] : null;
    }
    if (obj instanceof Map) {
      const key = String(idx);
      return obj.has(key) ? obj.get(key) : null;
    }
    if (obj instanceof HostObject) return hostGet(obj, idx);
    throw this.runtimeError(`cannot index ${typeName(obj)}`, line);
  }

  setIndex(obj, idx, value, line) {
    if (Array.isArray(obj)) {
      const i = this.intIndex(idx, line);
      if (i < 0) throw this.runtimeError("array index cannot be negative", line);
      obj[i] = value;
      return;
    }
    if (obj instanceof Map) {
      obj.set(String(idx), value);
      return;
    }
    if (obj instanceof HostObject) {
      hostSet(obj, idx, value);
      return;
    }
    throw this.runtimeError(`cannot index-assign ${typeName(obj)}`, line);
  }

  intIndex(idx, line) {
    if (typeof idx !== "number" || !Number.isInteger(idx)) {
      throw this.runtimeError(`array/string index must be an integer, got ${typeName(idx)}`, line);
    }
    return idx;
  }

  toIterable(value, line) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split("");
    if (value instanceof HostObject && Array.isArray(value.obj)) {
      return value.obj.map((x) => hostToScript(x, value.policy));
    }
    throw this.runtimeError(`cannot iterate over ${typeName(value)}`, line);
  }

  // Built-in array members (returned as raw NativeFns closing over the array).
  arrayMember(arr, name, line) {
    switch (name) {
      case "len":
      case "length":
        return arr.length;
      case "push":
        return new NativeFn((...items) => { arr.push(...items); return arr.length; }, "push", undefined, true);
      case "pop":
        return new NativeFn(() => (arr.length ? arr.pop() : null), "pop", undefined, true);
      case "indexOf":
        return new NativeFn((x) => arr.indexOf(x), "indexOf", undefined, true);
      case "join":
        return new NativeFn((sep) => arr.map((x) => stringify(x)).join(sep == null ? "," : String(sep)), "join", undefined, true);
      case "slice":
        return new NativeFn((a, b) => arr.slice(a ?? 0, b ?? arr.length), "slice", undefined, true);
      default:
        throw this.runtimeError(`array has no member '${name}'`, line);
    }
  }

  stringMember(str, name, line) {
    switch (name) {
      case "len":
      case "length":
        return str.length;
      case "upper":
        return new NativeFn(() => str.toUpperCase(), "upper", undefined, true);
      case "lower":
        return new NativeFn(() => str.toLowerCase(), "lower", undefined, true);
      case "slice":
        return new NativeFn((a, b) => str.slice(a ?? 0, b ?? str.length), "slice", undefined, true);
      case "indexOf":
        return new NativeFn((x) => str.indexOf(String(x)), "indexOf", undefined, true);
      case "split":
        return new NativeFn((sep) => str.split(sep == null ? "" : String(sep)), "split", undefined, true);
      case "contains":
        return new NativeFn((x) => str.includes(String(x)), "contains", undefined, true);
      default:
        throw this.runtimeError(`string has no member '${name}'`, line);
    }
  }

  // ---- operators ----

  applyBinary(op, l, r, line) {
    switch (op) {
      case "+":
        if (typeof l === "number" && typeof r === "number") return l + r;
        if (typeof l === "string" || typeof r === "string") return stringify(l) + stringify(r);
        throw this.runtimeError(`cannot apply '+' to ${typeName(l)} and ${typeName(r)}`, line);
      case "-": return this.num(l, line) - this.num(r, line);
      case "*": return this.num(l, line) * this.num(r, line);
      case "/": return this.num(l, line) / this.num(r, line);
      case "%": return this.num(l, line) % this.num(r, line);
      case "<": return this.compare(l, r, line) < 0;
      case "<=": return this.compare(l, r, line) <= 0;
      case ">": return this.compare(l, r, line) > 0;
      case ">=": return this.compare(l, r, line) >= 0;
      case "==": return valuesEqual(l, r);
      case "!=": return !valuesEqual(l, r);
      default:
        throw this.runtimeError(`unknown operator '${op}'`, line);
    }
  }

  num(v, line) {
    if (typeof v !== "number") {
      throw this.runtimeError(`expected a number, got ${typeName(v)}`, line);
    }
    return v;
  }

  compare(l, r, line) {
    if (typeof l === "number" && typeof r === "number") return l - r;
    if (typeof l === "string" && typeof r === "string") return l < r ? -1 : l > r ? 1 : 0;
    throw this.runtimeError(`cannot compare ${typeName(l)} and ${typeName(r)}`, line);
  }
}
