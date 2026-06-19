// Public API. This is the surface a host (the level editor) uses:
//
//   const vm = new Interpreter();
//   vm.defineGlobals({ spawn, engine });   // host layer — neatly separated
//   const program = vm.compile(source);
//   program.run();                          // run top level (defines handlers)
//   program.call("onClick", [objId]);       // fire an event handler later

import { Environment } from "./environment.js";
import { Evaluator } from "./interpreter.js";
import { parse } from "./parser.js";
import { defineGlobal, defineGlobals, hostToScript } from "./host.js";
import { installStdlib } from "./stdlib.js";
import { isCallable } from "./values.js";
import { LangError } from "./errors.js";

const DEFAULT_MAX_STEPS = 1_000_000;

export class Program {
  constructor(evaluator, ast, env) {
    this.evaluator = evaluator;
    this.ast = ast;
    this.env = env; // top-level scope (persists across calls)
  }

  // Execute the top-level statements. Run once before using call().
  // Returns the result directly for a synchronous script, or a Promise of the
  // result if the script suspends on `await` — so you can always safely write
  // `await program.run()` (awaiting a plain value is a no-op).
  run({ maxSteps = DEFAULT_MAX_STEPS, onStep = null } = {}) {
    this.evaluator.reset({ maxSteps, onStep });
    return this.evaluator.drive(this.evaluator.execProgram(this.ast, this.env));
  }

  // Invoke a function by name, including a dotted path to a method on an object
  // (e.g. "player.attack" or "engine.objects.hero.hurt"). `this` is bound for
  // method calls. Host-space args are marshalled in; the return value comes back.
  // Like run(), returns the value directly or a Promise if the handler awaits.
  call(name, args = [], { maxSteps = DEFAULT_MAX_STEPS, onStep = null } = {}) {
    this.evaluator.reset({ maxSteps, onStep });
    const fn = this.resolvePath(name);
    if (!isCallable(fn)) {
      throw new LangError(`'${name}' is not a function`, { phase: "runtime" });
    }
    const scriptArgs = args.map((a) => hostToScript(a));
    return this.evaluator.drive(this.evaluator.callValue(fn, scriptArgs, null));
  }

  // Call a script function VALUE (e.g. a callback the script handed to a host
  // function via `on(...)`). This is how the host fires stored listeners.
  invoke(fn, args = [], { maxSteps = DEFAULT_MAX_STEPS, onStep = null } = {}) {
    if (!isCallable(fn)) {
      throw new LangError("invoke() expects a function value", { phase: "runtime" });
    }
    this.evaluator.reset({ maxSteps, onStep });
    const scriptArgs = args.map((a) => hostToScript(a));
    return this.evaluator.drive(this.evaluator.callValue(fn, scriptArgs, null));
  }

  // Resolve a name or dotted path to a value, binding `this` along the way.
  resolvePath(path) {
    const parts = String(path).split(".");
    let val = this.env.get(parts[0], null);
    for (let i = 1; i < parts.length; i++) {
      val = this.evaluator.getMember(val, parts[i], null);
    }
    return val;
  }

  // Does a callable of this name/path exist (e.g. an optional event handler)?
  has(name) {
    try {
      return isCallable(this.resolvePath(name));
    } catch {
      return false;
    }
  }

  // Low-level generator over top-level execution, for the Debugger.
  generator() {
    return this.evaluator.execProgram(this.ast, this.env);
  }
}

export class Interpreter {
  constructor({ stdlib = true, print = null } = {}) {
    this.globals = new Environment();
    this.evaluator = new Evaluator();
    if (stdlib) installStdlib(this.globals, { print });
  }

  // options: { writable, extensible } control whether scripts may modify or add
  // keys to a registered host object (defaults: both true).
  defineGlobal(name, value, options = {}) {
    defineGlobal(this.globals, name, value, options);
    return this;
  }

  defineGlobals(obj, options = {}) {
    defineGlobals(this.globals, obj, options);
    return this;
  }

  // Parse source into a reusable Program with its own top-level scope.
  compile(source) {
    const ast = parse(source);
    return new Program(this.evaluator, ast, this.globals.child());
  }

  // Convenience: compile + run in one call.
  run(source, opts) {
    return this.compile(source).run(opts);
  }
}

export { LangError } from "./errors.js";
export { parse } from "./parser.js";
export { tokenize } from "./lexer.js";
export { Debugger } from "./debugger.js";
export { scriptToHost, hostToScript } from "./host.js";
export { stringify, typeName } from "./values.js";
export * from "./editor-support.js";
