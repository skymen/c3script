// Async demo: a script awaits promise-returning host functions and the built-in
// sleep/all helpers. run()/call() return a Promise once a script suspends on
// `await`, so you just `await` the call — synchronous scripts still return their
// value directly.
//
//   node examples/async.mjs

import assert from "node:assert/strict";
import { Interpreter, LangError } from "../src/index.js";

const line = (s) => console.log(s);
const banner = (s) => console.log(`\n=== ${s} ===`);

// A mock async "engine": load() returns a promise that resolves after a tick.
function makeEngine() {
  const levels = { level1: { tiles: 12 }, level2: { tiles: 30 } };
  return {
    load: (name) =>
      new Promise((resolve, reject) =>
        setTimeout(
          () => (levels[name] ? resolve(levels[name]) : reject(new Error(`no level '${name}'`))),
          5,
        ),
      ),
  };
}

// ---------------------------------------------------------------------------
// 1. await a host promise + sleep() + waitAll()
// ---------------------------------------------------------------------------
banner("1. await host promises, sleep, waitAll");
{
  const vm = new Interpreter({ print: line });
  vm.defineGlobals({ engine: makeEngine() });

  const result = await vm.compile(`
    print("loading...")
    let a = await engine.load("level1")
    await sleep(10)
    let b = await engine.load("level2")
    let both = await waitAll([engine.load("level1"), engine.load("level2")])
    print("level1 tiles: " + a.tiles)
    print("level2 tiles: " + b.tiles)
    print("loaded " + len(both) + " levels at once")
    return a.tiles + b.tiles
  `).run();

  assert.equal(result, 42);
  line(`OK: total tiles = ${result}`);
}

// ---------------------------------------------------------------------------
// 2. async event handler fired via call() (which returns a Promise)
// ---------------------------------------------------------------------------
banner("2. async event handler (await program.call)");
{
  const vm = new Interpreter({ print: line });
  vm.defineGlobals({ engine: makeEngine() });

  const program = vm.compile(`
    function onLoad(name) {
      let level = await engine.load(name)
      return level.tiles
    }
  `);
  program.run(); // define the handler (sync top level)

  const tiles = await program.call("onLoad", ["level2"]);
  assert.equal(tiles, 30);
  line(`OK: onLoad("level2") -> ${tiles} tiles`);
}

// ---------------------------------------------------------------------------
// 3. a rejected await propagates to the host as a LangError
// ---------------------------------------------------------------------------
banner("3. rejected await -> LangError (no try/catch in the language)");
{
  const vm = new Interpreter({ print: line });
  vm.defineGlobals({ engine: makeEngine() });
  try {
    await vm.compile(`await engine.load("missing")`).run();
    assert.fail("should have rejected");
  } catch (e) {
    assert.ok(e instanceof LangError);
    line(`OK: caught -> ${e.format()}`);
  }
}

console.log("\nAll async demo assertions passed.");
