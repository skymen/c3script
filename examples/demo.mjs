// End-to-end demo: runs the example scripts against a *mock* level editor so
// you can see the host boundary, per-object behaviors, the live nested-object
// bridge, the fuel limit, and the debugger — all without a real editor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { Interpreter, Debugger, LangError } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");

const line = (s) => console.log(s);
const banner = (s) => console.log(`\n=== ${s} ===`);

// ---------------------------------------------------------------------------
// 1. Procedural generation — scripts drive host functions.
// ---------------------------------------------------------------------------
banner("1. Procedural generation");
{
  const editor = { tiles: [], spawns: [] };
  const vm = new Interpreter({ print: line });
  vm.defineGlobals({
    setTile: (x, y, t) => editor.tiles.push({ x, y, t }),
    spawn: (type, x, y) => editor.spawns.push({ type, x, y }),
  });

  vm.run(read("proc-gen.script"));

  assert.equal(editor.tiles.length, 5, "should place 5 tiles");
  assert.equal(editor.spawns.length, 4, "should spawn 3 enemies + 1 boss");
  assert.deepEqual(editor.spawns.at(-1), { type: "Dragon", x: 5, y: 0 });
  line(
    `OK: editor recorded ${editor.tiles.length} tiles, ${editor.spawns.length} spawns`,
  );
}

// ---------------------------------------------------------------------------
// 2. Per-object behavior + live nested-object bridge.
// ---------------------------------------------------------------------------
banner("2. Per-object behaviors (engine.objects.<id>.hp live bridge)");
{
  // Live editor state. The script reads/writes engine.objects[id].hp directly.
  const editor = {
    objects: { hero: { hp: 30 }, goblin: { hp: 20 } },
    destroyed: [],
  };
  const engine = {
    objects: editor.objects, // same reference -> live access
    destroy: (id) => {
      editor.destroyed.push(id);
      delete editor.objects[id];
    },
  };

  const vm = new Interpreter({ print: line });
  vm.defineGlobals({ engine });

  // Each object gets its own program instance => its own persistent state.
  const source = read("behavior.script");
  const heroProg = vm.compile(source);
  heroProg.run(); // run top level once to define handlers + state

  heroProg.call("onSpawn", ["hero"]);
  const c1 = heroProg.call("onClick", ["hero"]); // 30 -> 20
  const c2 = heroProg.call("onClick", ["hero"]); // 20 -> 10

  assert.equal(c1, 1);
  assert.equal(c2, 2, "click counter persists across event calls");
  assert.equal(
    editor.objects.hero.hp,
    10,
    "live write propagated to host object",
  );
  line(
    `OK: hero hp is now ${editor.objects.hero.hp}, clicks persisted (${c2})`,
  );

  // Drive it to destruction.
  heroProg.call("onClick", ["hero"]); // 10 -> 0 -> destroy
  assert.deepEqual(editor.destroyed, ["hero"]);
  assert.equal(editor.objects.hero, undefined);
  line(
    `OK: hero destroyed via engine.destroy(), destroyed=${JSON.stringify(editor.destroyed)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Fuel limit stops runaway scripts.
// ---------------------------------------------------------------------------
banner("3. Fuel limit (infinite-loop protection)");
{
  const vm = new Interpreter({ print: line });
  try {
    vm.run("let i = 0\nwhile (true) { i = i + 1 }", { maxSteps: 5000 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof LangError);
    line(`OK: caught -> ${e.format()}`);
  }
}

// ---------------------------------------------------------------------------
// 4. The debugger: breakpoints, stepping, scope inspection.
// ---------------------------------------------------------------------------
banner("4. Debugger (breakpoint + locals + call stack)");
{
  const src = [
    "let total = 0", //                           line 1
    "for (let i = 1; i <= 3; i = i + 1) {", //    line 2
    "  total = total + i", //                     line 3
    "}", //                                       line 4
    "print(total)", //                            line 5
  ].join("\n");

  const vm = new Interpreter({ print: line });
  const program = vm.compile(src);
  const dbg = new Debugger(program).start();
  dbg.addBreakpoint(3); // pause whenever line 3 is about to run

  let hits = 0;
  while (dbg.resume()) {
    hits++;
    line(`  break #${hits} @ ${dbg.describe()}`);
  }
  assert.equal(hits, 3, "breakpoint on loop body should hit 3 times");
  line(`OK: hit the loop-body breakpoint ${hits} times`);
}

// ---------------------------------------------------------------------------
// 5. Rich runtime errors with line + script call stack.
// ---------------------------------------------------------------------------
banner("5. Runtime error reporting");
{
  const vm = new Interpreter({ print: line });
  try {
    vm.run(
      [
        "function boom() { return missing + 1 }",
        "function outer() { return boom() }",
        "outer()",
      ].join("\n"),
    );
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof LangError);
    line(e.format());
  }
}

console.log("\nAll demo assertions passed.");
