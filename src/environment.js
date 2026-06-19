// Lexical scope chain. Each scope maps names to values; closures capture the
// scope they were defined in. The root scope holds host-registered globals.

import { LangError } from "./errors.js";

export class Environment {
  constructor(parent = null) {
    this.vars = new Map();
    this.consts = new Set();
    this.parent = parent;
  }

  child() {
    return new Environment(this);
  }

  define(name, value, isConst = false) {
    this.vars.set(name, value);
    if (isConst) this.consts.add(name);
    else this.consts.delete(name);
  }

  get(name, line) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) return env.vars.get(name);
      env = env.parent;
    }
    throw new LangError(`undefined variable '${name}'`, { line, phase: "runtime" });
  }

  assign(name, value, line) {
    let env = this;
    while (env) {
      if (env.vars.has(name)) {
        if (env.consts.has(name)) {
          throw new LangError(`cannot assign to const '${name}'`, { line, phase: "runtime" });
        }
        env.vars.set(name, value);
        return value;
      }
      env = env.parent;
    }
    throw new LangError(`undefined variable '${name}'`, { line, phase: "runtime" });
  }
}
