import { test } from "node:test";
import assert from "node:assert/strict";
import { Interpreter, Debugger, LangError, scriptToHost } from "../src/index.js";

// Run a script, capturing print() output. Returns { result, out, program, vm }.
function run(src, globals = {}) {
  const out = [];
  const vm = new Interpreter({ print: (s) => out.push(s) });
  vm.defineGlobals(globals);
  const program = vm.compile(src);
  const result = program.run();
  return { result, out, program, vm };
}

test("arithmetic precedence and associativity", () => {
  assert.deepEqual(run("print(1 + 2 * 3)").out, ["7"]);
  assert.deepEqual(run("print((1 + 2) * 3)").out, ["9"]);
  assert.deepEqual(run("print(2 - 3 - 1)").out, ["-2"]); // left-associative: (2-3)-1
  assert.deepEqual(run("print(7 % 3)").out, ["1"]);
  assert.deepEqual(run("print(-(2 + 3))").out, ["-5"]);
});

test("variables and assignment, compound operators", () => {
  assert.deepEqual(run("let x = 5\nx = x + 1\nprint(x)").out, ["6"]);
  assert.deepEqual(run("let x = 10\nx += 5\nx -= 3\nprint(x)").out, ["12"]);
});

test("const cannot be reassigned", () => {
  assert.throws(() => run("const x = 1\nx = 2"), (e) => e instanceof LangError);
});

test("undefined variable is a runtime error with a line", () => {
  assert.throws(
    () => run("print(nope)"),
    (e) => e instanceof LangError && e.phase === "runtime" && /undefined variable/.test(e.langMessage),
  );
});

test("strings: concat, coercion, methods", () => {
  assert.deepEqual(run("print('a' + 1)").out, ["a1"]);
  assert.deepEqual(run("print('hi'.upper())").out, ["HI"]);
  assert.deepEqual(run("print('a,b,c'.split(',').len)").out, ["3"]);
  assert.deepEqual(run("print('hello'.slice(1, 3))").out, ["el"]);
});

test("booleans, comparison, logical, ternary, truthiness", () => {
  assert.deepEqual(run("print(1 < 2 && 3 >= 3)").out, ["true"]);
  assert.deepEqual(run("print(false || 'x')").out, ["x"]); // returns operand
  assert.deepEqual(run("print(0 ? 'y' : 'n')").out, ["n"]); // 0 is falsy
  assert.deepEqual(run("print('' ? 1 : 2)").out, ["2"]);
  assert.deepEqual(run("print(!null)").out, ["true"]);
});

test("if / else, while, for, break, continue", () => {
  assert.deepEqual(run("if (2 > 1) { print('a') } else { print('b') }").out, ["a"]);
  assert.deepEqual(
    run("let s = 0\nlet i = 0\nwhile (i < 5) { i = i + 1; if (i == 3) { continue } s = s + i }\nprint(s)").out,
    ["12"], // 1+2+4+5
  );
  assert.deepEqual(
    run("let s = 0\nfor (let i = 0; i < 10; i = i + 1) { if (i == 5) { break } s = s + i }\nprint(s)").out,
    ["10"], // 0+1+2+3+4
  );
});

test("functions, recursion, and closures", () => {
  assert.deepEqual(run("function f(n) { if (n <= 1) { return 1 } return n * f(n - 1) }\nprint(f(5))").out, ["120"]);
  assert.deepEqual(
    run("function mk() { let n = 0\n return function() { n = n + 1\n return n } }\nlet c = mk()\nprint(c())\nprint(c())\nprint(c())").out,
    ["1", "2", "3"],
  );
  assert.deepEqual(run("let add = (a, b) => a + b\nprint(add(4, 5))").out, ["9"]);
});

test("arrays: literals, index, push, len, for-of", () => {
  assert.deepEqual(run("let a = [1, 2, 3]\nprint(a[0] + a[2])").out, ["4"]);
  assert.deepEqual(run("let a = [1]\na.push(2)\na.push(3)\nprint(a.len)").out, ["3"]);
  assert.deepEqual(run("let a = [10, 20, 30]\nlet s = 0\nfor (let x of a) { s = s + x }\nprint(s)").out, ["60"]);
  assert.deepEqual(run("let a = [1, 2]\na[5] = 9\nprint(a.len)").out, ["6"]);
});

test("objects: literals, member and index access/assignment", () => {
  assert.deepEqual(run("let o = { a: 1, b: 2 }\no.c = 3\no['d'] = 4\nprint(o.a + o.b + o.c + o.d)").out, ["10"]);
  assert.deepEqual(run("let o = {}\nprint(o.missing)").out, ["null"]);
});

test("classes: instances, this, methods, chaining", () => {
  const src = [
    "class Counter {",
    "  constructor() { this.n = 0 }",
    "  inc() { this.n = this.n + 1; return this }",
    "  get() { return this.n }",
    "}",
    "let c = new Counter()",
    "c.inc()",
    "c.inc()",
    "print(c.get())",
  ].join("\n");
  assert.deepEqual(run(src).out, ["2"]);
});

test("host functions receive marshalled args and return values", () => {
  const { out } = run("print(add(2, 3))\nprint(sum([1, 2, 3, 4]))", {
    add: (a, b) => a + b,
    sum: (arr) => arr.reduce((a, b) => a + b, 0),
  });
  assert.deepEqual(out, ["5", "10"]);
});

test("namespaced host object with live bridge (read + write back)", () => {
  const editor = { objects: { e1: { hp: 100 } }, log: [] };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({
    engine: {
      objects: editor.objects, // same reference -> live
      spawn: (t, x, y) => editor.log.push([t, x, y]),
    },
  });
  const p = vm.compile(
    "function hit(id) { engine.objects[id].hp = engine.objects[id].hp - 10; return engine.objects[id].hp }\nengine.spawn('g', 1, 2)",
  );
  p.run();
  assert.deepEqual(editor.log, [["g", 1, 2]]);
  const hp = p.call("hit", ["e1"]);
  assert.equal(hp, 90);
  assert.equal(editor.objects.e1.hp, 90, "write propagated back to the host object");
});

test("per-object state persists across event calls", () => {
  const vm = new Interpreter({ print: () => {} });
  const p = vm.compile("let n = 0\nfunction tick() { n = n + 1; return n }");
  p.run();
  assert.equal(p.call("tick"), 1);
  assert.equal(p.call("tick"), 2);
  assert.equal(p.call("tick"), 3);
});

test("fuel limit stops infinite loops", () => {
  assert.throws(
    () => run("while (true) { let x = 1 }"),
    (e) => e instanceof LangError && /step limit/.test(e.langMessage),
  );
});

test("calling a non-function is a runtime error", () => {
  assert.throws(() => run("let x = 5\nx()"), (e) => e instanceof LangError && /not callable/.test(e.langMessage));
});

test("type errors are reported", () => {
  assert.throws(() => run("print(1 + true)"), (e) => e instanceof LangError && /cannot apply/.test(e.langMessage));
});

test("parse errors carry phase and line", () => {
  assert.throws(
    () => run("let = 5"),
    (e) => e instanceof LangError && e.phase === "parse" && typeof e.line === "number",
  );
});

test("runtime error includes a script call stack", () => {
  try {
    run("function a() { return missing }\nfunction b() { return a() }\nb()");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof LangError);
    const names = e.scriptStack.map((f) => f.name);
    assert.ok(names.includes("a") && names.includes("b"), `stack was ${JSON.stringify(names)}`);
  }
});

test("scriptToHost converts arrays and objects back to plain JS", () => {
  const vm = new Interpreter({ print: () => {} });
  const p = vm.compile("function make() { return { name: 'x', vals: [1, 2, 3] } }");
  p.run();
  const obj = scriptToHost(p.call("make"));
  assert.deepEqual(obj, { name: "x", vals: [1, 2, 3] });
});

test("debugger: step, locals, and value inspection", () => {
  const src = "let a = 1\nlet b = 2\nlet c = a + b\nprint(c)";
  const vm = new Interpreter({ print: () => {} });
  const dbg = new Debugger(vm.compile(src)).start();
  let inspected = false;
  let cp;
  while ((cp = dbg.step()) !== null) {
    if (cp.line === 4) {
      assert.equal(dbg.value("a"), 1);
      assert.equal(dbg.value("b"), 2);
      assert.equal(dbg.value("c"), 3);
      assert.deepEqual(Object.keys(dbg.locals()).sort(), ["a", "b", "c"]);
      inspected = true;
    }
  }
  assert.ok(inspected, "should have paused at line 4");
});

test("debugger: breakpoint hit count", () => {
  const src = "let t = 0\nfor (let i = 1; i <= 3; i = i + 1) {\n  t = t + i\n}\nprint(t)";
  const vm = new Interpreter({ print: () => {} });
  const dbg = new Debugger(vm.compile(src)).start();
  dbg.addBreakpoint(3);
  let hits = 0;
  while (dbg.resume()) hits++;
  assert.equal(hits, 3);
});

test("nested function declarations and closures", () => {
  const src = [
    "function outer(x) {",
    "  function inner(y) { return x + y }", // inner closes over outer's x
    "  return inner(10)",
    "}",
    "print(outer(5))",
  ].join("\n");
  assert.deepEqual(run(src).out, ["15"]);
});

test("class inheritance: extends, super constructor, super method, override", () => {
  const src = [
    "class Animal {",
    "  constructor(name) { this.name = name }",
    "  speak() { return this.name + ' makes a sound' }",
    "}",
    "class Dog extends Animal {",
    "  constructor(name) { super(name); this.legs = 4 }",
    "  speak() { return super.speak() + ' (woof)' }",
    "}",
    "let d = new Dog('Rex')",
    "print(d.speak())",
    "print(d.name)", // inherited field set via super()
    "print(d.legs)",
  ].join("\n");
  assert.deepEqual(run(src).out, ["Rex makes a sound (woof)", "Rex", "4"]);
});

test("inherited method works without override", () => {
  const src = [
    "class A { hello() { return 'hi' } }",
    "class B extends A {}",
    "print(new B().hello())",
  ].join("\n");
  assert.deepEqual(run(src).out, ["hi"]);
});

test("dotted .call invokes a method and binds this", () => {
  const vm = new Interpreter({ print: () => {} });
  const p = vm.compile([
    "class Player {",
    "  constructor() { this.hp = 100 }",
    "  hurt(n) { this.hp = this.hp - n; return this.hp }",
    "}",
    "let player = new Player()",
  ].join("\n"));
  p.run();
  assert.equal(p.call("player.hurt", [30]), 70);
  assert.equal(p.call("player.hurt", [20]), 50);
  assert.ok(p.has("player.hurt"));
  assert.ok(!p.has("player.missing"));
});

test("shared scope: scripts can write new keys to a host object", () => {
  const shared = {}; // one object shared across instances
  const out = [];
  const vm = new Interpreter({ print: (s) => out.push(s) });
  vm.defineGlobals({ global: shared });

  // First program writes brand-new keys (the object started empty).
  vm.compile("global.myValue = 'test'\nglobal.count = 1").run();
  assert.equal(shared.myValue, "test");
  assert.equal(shared.count, 1);

  // A second program (separate top-level scope) sees the shared writes.
  vm.compile("global.count = global.count + 1\nprint(global.myValue)\nprint(global.count)").run();
  assert.equal(shared.count, 2);
  assert.deepEqual(out, ["test", "2"]);
});

test("read-only host object rejects writes", () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("cfg", { speed: 5 }, { writable: false });
  assert.throws(
    () => vm.compile("cfg.speed = 10").run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
});

test("sealed (non-extensible) host object rejects new keys but allows updates", () => {
  const state = { hp: 10 };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("state", state, { extensible: false });
  // Updating an existing key is fine.
  vm.compile("state.hp = 3").run();
  assert.equal(state.hp, 3);
  // Adding a new key is rejected.
  assert.throws(
    () => vm.compile("state.mana = 50").run(),
    (e) => e instanceof LangError && /sealed/.test(e.langMessage),
  );
});

test("event pattern: host stores script callbacks and fires them via invoke", () => {
  const fired = [];
  const bus = { listeners: [] };
  const player = { on: (ev, cb) => bus.listeners.push({ ev, cb }) };
  const game = { objects: { player } };

  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ game, record: (s) => fired.push(s) });

  const p = vm.compile([
    "let hits = 0",
    "game.objects.player.on('hurt', (e) => {",
    "  hits = hits + 1",
    "  record('hurt ' + e.amount + ' (#' + hits + ')')",
    "})",
  ].join("\n"));
  p.run();

  // Host fires the stored callback twice with different payloads.
  for (const l of bus.listeners) {
    p.invoke(l.cb, [{ amount: 10 }]);
    p.invoke(l.cb, [{ amount: 25 }]);
  }
  assert.deepEqual(fired, ["hurt 10 (#1)", "hurt 25 (#2)"]); // state persists
});

test("sandbox: prototype pollution is blocked", () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ game: { objects: { player: { hp: 1 } } } });
  assert.equal(({}).polluted, undefined);
  // Both the navigate-then-write and the direct __proto__ write must be blocked.
  assert.throws(() => vm.run(`game.__proto__.polluted = "x"`), (e) => e instanceof LangError);
  assert.throws(
    () => vm.run(`game.__proto__ = game`),
    (e) => e instanceof LangError && /unsafe property/.test(e.langMessage),
  );
  assert.equal(({}).polluted, undefined, "Object.prototype must be untouched");
});

test("sandbox: dangerous keys read as null, not host internals", () => {
  const vm = new Interpreter({ print: (s) => out.push(s) });
  const out = [];
  vm.defineGlobals({ game: { events: ["a"], objects: {} } });
  vm.run([
    "print(type(game.constructor))",
    "print(type(game.__proto__))",
    "print(type(game.events.prototype))",
  ].join("\n"));
  assert.deepEqual(out, ["null", "null", "null"]);
});

test("sandbox: only own properties are reachable (no inherited methods)", () => {
  const vm = new Interpreter({ print: (s) => out.push(s) });
  const out = [];
  vm.defineGlobals({ game: { real: 42, greet: () => "hi" } });
  vm.run([
    "print(game.real)",                 // own data -> ok
    "print(game.greet())",              // own method -> ok
    "print(type(game.hasOwnProperty))", // inherited -> null
    "print(type(game.toString))",       // inherited -> null
  ].join("\n"));
  assert.deepEqual(out, ["42", "hi", "null", "null"]);
});

test("sandbox: the constructor.constructor RCE gadget cannot assemble", () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ game: { objects: {} } });
  // constructor reads as null, so chaining throws "cannot read property of null".
  assert.throws(
    () => vm.run(`game.constructor.constructor("return 1")`),
    (e) => e instanceof LangError,
  );
});

test("raw builtins receive script values (raw flag is honored)", () => {
  // type() of a function value is "function" (would be "unknown" if args were
  // marshalled), and len() works on a script object/map.
  assert.deepEqual(run("print(type(len))").out, ["function"]);
  assert.deepEqual(run("print(len({ a: 1, b: 2 }))").out, ["2"]);
  assert.deepEqual(run("print(keys({ a: 1, b: 2 }).len)").out, ["2"]);
});

test("sandbox: DoS vectors fail gracefully (LangError, not a crash)", () => {
  // cyclic structure passed to a host function
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ sink: (x) => x });
  assert.throws(
    () => vm.run("let a = {}\na.self = a\nsink(a)"),
    (e) => e instanceof LangError && /cyclic/.test(e.langMessage),
  );

  // runaway recursion
  assert.throws(
    () => run("function f(n) { return f(n + 1) }\nf(0)"),
    (e) => e instanceof LangError && /call stack/.test(e.langMessage),
  );

  // pathologically nested source
  const deep = "let x = " + "[".repeat(5000) + "1" + "]".repeat(5000);
  assert.throws(
    () => run(deep),
    (e) => e instanceof LangError && e.phase === "parse",
  );
});

test("sandbox: printing a cyclic value does not crash", () => {
  assert.deepEqual(run("let a = [1]\na.push(a)\nprint(a)").out, ["[1, [...]]"]);
});

test("range and math built-ins", () => {
  assert.deepEqual(run("let s = 0\nfor (let i of range(5)) { s = s + i }\nprint(s)").out, ["10"]);
  assert.deepEqual(run("print(max(3, 9, 2))\nprint(floor(3.7))\nprint(abs(-4))").out, ["9", "3", "4"]);
});
