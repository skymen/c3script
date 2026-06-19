// Security probe / regression test for the c3script sandbox.
//
// It runs a battery of escape attempts (prototype pollution, prototype-chain
// climbing to Object/Function, reaching globalThis) and asserts every one is
// BLOCKED. Exits non-zero if any escape succeeds. Run: `node examples/sandbox-escape.mjs`.
//
// These all used to work before the host-bridge was restricted to own
// properties with a dangerous-key denylist (see src/host.js).

import { Interpreter } from "../src/index.js";

let failures = 0;
const SENTINEL = "__c3_pwned__";

function fresh() {
  const vm = new Interpreter({ print: () => {} });
  // A representative host surface: nested objects, an array, methods.
  vm.defineGlobals({
    game: {
      events: ["a", "b"],
      objects: { player: { hp: 100 } },
      on() {},
    },
  });
  return vm;
}

// An attack "passes" (is safe) if it either throws a LangError or runs without
// achieving its goal. We additionally check global side effects separately.
function mustNotEscape(label, src) {
  const vm = fresh();
  let note = "ran";
  try {
    vm.run(src);
  } catch (e) {
    note = "threw: " + (e.langMessage || e.message);
  }
  // No attack may pollute Object.prototype.
  if (Object.prototype[SENTINEL] !== undefined) {
    console.log(`  FAIL  ${label}  -> POLLUTED Object.prototype!`);
    delete Object.prototype[SENTINEL];
    failures++;
    return;
  }
  console.log(`  ok    ${label}  (${note})`);
}

// For attacks that try to *obtain* a dangerous value, assert the script-level
// result is null/blocked. We surface the result through a raw check function.
function mustResolveNull(label, expr) {
  const vm = fresh();
  let leaked = false;
  vm.defineGlobal("__check", (v) => { if (v !== null && v !== undefined) leaked = true; });
  let threw = false;
  try {
    vm.run(`__check(${expr})`);
  } catch {
    threw = true; // throwing is also a safe outcome
  }
  if (leaked && !threw) {
    console.log(`  FAIL  ${label}  -> leaked a non-null value: ${expr}`);
    failures++;
  } else {
    console.log(`  ok    ${label}  (${threw ? "threw" : "null"})`);
  }
}

console.log("Sandbox escape probe:\n");

// 1. Prototype pollution.
mustNotEscape("pollute via game.__proto__", `game.__proto__.${SENTINEL} = 1`);
mustNotEscape("pollute via objects.__proto__", `game.objects.__proto__.${SENTINEL} = 1`);
mustNotEscape("pollute via array.__proto__", `game.events.__proto__.${SENTINEL} = 1`);
mustNotEscape("pollute via constructor.prototype", `game.constructor.prototype.${SENTINEL} = 1`);
mustNotEscape("assign __proto__ directly", `game.__proto__ = game`);

// 2. Reaching dangerous values must yield null (own-property-only + denylist).
mustResolveNull("read constructor", "game.constructor");
mustResolveNull("read __proto__", "game.__proto__");
mustResolveNull("read prototype", "game.events.prototype");
mustResolveNull("read inherited method (hasOwnProperty)", "game.hasOwnProperty");
mustResolveNull("read inherited toString", "game.toString");
mustResolveNull("index constructor", `game["constructor"]`);
mustResolveNull("nested constructor", "game.objects.player.constructor");

// 3. The classic RCE gadget chain must not assemble.
mustNotEscape("RCE: constructor.constructor", `game.constructor.constructor("return 1")`);
mustNotEscape("RCE via array", `game.events.constructor.constructor("x")`);

console.log("");
if (failures > 0) {
  console.log(`FAILED: ${failures} escape(s) succeeded — sandbox is broken.`);
  process.exit(1);
} else {
  console.log("PASSED: all escape attempts were blocked.");
}
