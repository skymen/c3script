// Tiny interactive REPL. State persists across lines; the value of a trailing
// expression is echoed. Ctrl+C / Ctrl+D to exit.

import readline from "node:readline";
import { Environment } from "../src/environment.js";
import { Evaluator } from "../src/interpreter.js";
import { installCoreGlobals } from "../src/stdlib.js";
import { defineGlobals } from "../src/host.js";
import { parse } from "../src/parser.js";
import { stringify } from "../src/values.js";
import { LangError } from "../src/errors.js";
import { MathModule } from "./stdlib-modules.mjs";

const globals = new Environment();
installCoreGlobals(globals);
// Math is a namespaced module the host installs — read-only so `Math.floor`
// can't be clobbered. (See examples/stdlib-modules.mjs.)
defineGlobals(globals, { Math: MathModule }, { writable: false, extensible: false });
const env = globals.child();
const ev = new Evaluator();

function evalLine(src) {
  const ast = parse(src);
  ev.reset({ maxSteps: 5_000_000 });
  const body = ast.body;
  let result = null;
  const gen = (function* () {
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      if (i === body.length - 1 && stmt.type === "ExprStmt") {
        result = yield* ev.evalExpr(stmt.expression, env);
      } else {
        yield* ev.execStmt(stmt, env);
      }
    }
  })();
  ev.drive(gen);
  if (result !== null) console.log(stringify(result));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "c3> ",
});

console.log("c3script REPL — type expressions or statements. Ctrl+D to exit.");
rl.prompt();

rl.on("line", (raw) => {
  const src = raw.trim();
  if (src) {
    try {
      evalLine(src);
    } catch (e) {
      console.error(e instanceof LangError ? e.format() : String(e));
    }
  }
  rl.prompt();
});

rl.on("close", () => {
  console.log("bye");
  process.exit(0);
});
