// A small debugger built directly on the generator-based evaluator. Because the
// interpreter yields a checkpoint before each statement, this thin driver gets
// single-step, run-to-breakpoint, fuel limiting, and scope/stack inspection for
// almost no extra machinery.
//
//   const dbg = new Debugger(program).start();
//   dbg.addBreakpoint(7);
//   dbg.resume();              // run until line 7
//   dbg.locals();              // { i: 3, total: 6 }
//   dbg.stack();               // [{ name, line }, ...]
//   dbg.step();                // advance one statement

import { stringify } from "./values.js";
import { LangError } from "./errors.js";

export class Debugger {
  constructor(program, { maxSteps = 1_000_000 } = {}) {
    this.program = program;
    this.evaluator = program.evaluator;
    this.breakpoints = new Set();
    this.maxSteps = maxSteps;
    this.gen = null;
    this.current = null; // last checkpoint { line, kind, env }
    this.done = false;
    this.result = undefined;
  }

  start() {
    this.evaluator.reset({ maxSteps: this.maxSteps, onStep: null });
    this.gen = this.program.generator();
    this.current = null;
    this.done = false;
    this.result = undefined;
    return this;
  }

  addBreakpoint(line) {
    this.breakpoints.add(line);
    return this;
  }

  removeBreakpoint(line) {
    this.breakpoints.delete(line);
    return this;
  }

  // Advance to the next statement. Returns the checkpoint about to execute,
  // or null when the program has finished.
  step() {
    if (this.done) return null;
    if (!this.gen) this.start();
    const res = this.gen.next();
    if (res.done) {
      this.done = true;
      this.result = res.value;
      this.current = null;
      return null;
    }
    if (res.value && res.value.__await) {
      throw new LangError(
        "the debugger does not support stepping across 'await'",
        { line: res.value.line, phase: "runtime" },
      );
    }
    this.current = res.value;
    this.evaluator.stepCheck(this.current); // count step + enforce fuel limit
    return this.current;
  }

  // Run until the next breakpoint line is reached, or the program finishes.
  resume() {
    while (true) {
      const cp = this.step();
      if (cp === null) return null;
      if (this.breakpoints.has(cp.line)) return cp;
    }
  }

  // Run to completion, returning the program's result.
  run() {
    while (this.step() !== null) {
      /* keep stepping */
    }
    return this.result;
  }

  get line() {
    return this.current ? this.current.line : null;
  }

  // Local variables visible at the current pause point (innermost scope first),
  // excluding the global/stdlib scope.
  locals() {
    const out = {};
    let env = this.current ? this.current.env : null;
    while (env && env.parent) {
      for (const [k, v] of env.vars) if (!(k in out)) out[k] = v;
      env = env.parent;
    }
    return out;
  }

  // Read a single variable visible at the pause point (null if not found).
  value(name) {
    let env = this.current ? this.current.env : null;
    while (env) {
      if (env.vars.has(name)) return env.vars.get(name);
      env = env.parent;
    }
    return null;
  }

  // Current script call stack (innermost first).
  stack() {
    return this.evaluator.stackTrace();
  }

  // One-line textual snapshot of the pause point.
  describe() {
    if (this.done) return "(finished)";
    const vars = this.locals();
    const varStr = Object.keys(vars)
      .map((k) => `${k}=${stringify(vars[k])}`)
      .join(", ");
    return `line ${this.line} [${this.current.kind}]: {${varStr}}`;
  }
}
