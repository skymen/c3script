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

test("per-field policy: only some keys are writable", () => {
  const config = { speed: 5, name: "x" };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("config", config, { fields: { name: { writable: false } } });
  // The un-overridden key inherits the object's default (writable).
  vm.compile("config.speed = 10").run();
  assert.equal(config.speed, 10);
  // The per-field read-only key is rejected (member form).
  assert.throws(
    () => vm.compile('config.name = "y"').run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
  // ...and the index form goes through the same enforcement.
  assert.throws(
    () => vm.compile('config["name"] = "z"').run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
  assert.equal(config.name, "x");
});

test("per-field policy: read-only object with a writable subtree", () => {
  const game = { hp: 100, player: { hp: 50 } };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("game", game, {
    writable: false,
    extensible: false,
    fields: { player: { writable: true, extensible: true } },
  });
  // The root is read-only.
  assert.throws(
    () => vm.compile("game.hp = 1").run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
  // The player subtree is mutable and extensible.
  vm.compile("game.player.hp = 5").run();
  assert.equal(game.player.hp, 5);
  vm.compile("game.player.mana = 10").run();
  assert.equal(game.player.mana, 10);
});

test("per-field policy: a field override does not grant key creation", () => {
  const obj = { existing: 1 };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("obj", obj, {
    extensible: false,
    fields: { foo: { writable: true } },
  });
  // `foo` is absent; creation is governed by the object's extensible, not the field.
  assert.throws(
    () => vm.compile("obj.foo = 1").run(),
    (e) => e instanceof LangError && /sealed/.test(e.langMessage),
  );
});

test("per-field policy: a false override wins over a writable parent", () => {
  const obj = { locked: 1 };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("obj", obj, { writable: true, fields: { locked: { writable: false } } });
  assert.throws(
    () => vm.compile("obj.locked = 2").run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
  assert.equal(obj.locked, 1);
});

test("per-field policy: nested fields apply three levels deep", () => {
  const game = { player: { hp: 50, stats: { str: 5 } } };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("game", game, {
    fields: { player: { fields: { stats: { writable: false } } } },
  });
  // player.hp inherits the default (writable); stats is locked.
  vm.compile("game.player.hp = 1").run();
  assert.equal(game.player.hp, 1);
  assert.throws(
    () => vm.compile("game.player.stats.str = 1").run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
  );
});

test("per-field policy: a flat policy with no fields behaves as before", () => {
  const obj = { nested: { x: 1 } };
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobal("obj", obj, { writable: false });
  // The read-only policy still propagates to nested objects.
  assert.throws(
    () => vm.compile("obj.nested.x = 2").run(),
    (e) => e instanceof LangError && /read-only/.test(e.langMessage),
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
    "print(typeof game.constructor)",
    "print(typeof game.__proto__)",
    "print(typeof game.events.prototype)",
  ].join("\n"));
  assert.deepEqual(out, ["null", "null", "null"]);
});

test("sandbox: only own properties are reachable (no inherited methods)", () => {
  const vm = new Interpreter({ print: (s) => out.push(s) });
  const out = [];
  vm.defineGlobals({ game: { real: 42, greet: () => "hi" } });
  vm.run([
    "print(game.real)",                   // own data -> ok
    "print(game.greet())",                // own method -> ok
    "print(typeof game.hasOwnProperty)",  // inherited -> null
    "print(typeof game.toString)",        // inherited -> null
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
  // typeof a function value is "function" (would be "unknown" if args were
  // marshalled), and len() works on a script object/map.
  assert.deepEqual(run("print(typeof len)").out, ["function"]);
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

test("typeof operator reports value type names", () => {
  assert.deepEqual(run("print(typeof 1)").out, ["number"]);
  assert.deepEqual(run("print(typeof 'x')").out, ["string"]);
  assert.deepEqual(run("print(typeof true)").out, ["bool"]);
  assert.deepEqual(run("print(typeof null)").out, ["null"]);
  assert.deepEqual(run("print(typeof [1, 2])").out, ["array"]);
  assert.deepEqual(run("print(typeof { a: 1 })").out, ["object"]);
  assert.deepEqual(run("print(typeof print)").out, ["function"]);
  assert.deepEqual(run("class C {}\nprint(typeof C)\nprint(typeof new C())").out, ["class", "instance"]);
});

test("typeof binds like a unary op (looser than call/member, tighter than binary)", () => {
  assert.deepEqual(run("print(typeof 'hi'.upper())").out, ["string"]); // typeof ('hi'.upper())
  assert.deepEqual(run("print(typeof 1 == 'number')").out, ["true"]);  // (typeof 1) == 'number'
});

test("instanceof checks the class, walking the inheritance chain", () => {
  const src = [
    "class Animal {}",
    "class Dog extends Animal {}",
    "class Cat extends Animal {}",
    "let d = new Dog()",
    "print(d instanceof Dog)",     // true
    "print(d instanceof Animal)",  // true (parent)
    "print(d instanceof Cat)",     // false (sibling)
  ].join("\n");
  assert.deepEqual(run(src).out, ["true", "true", "false"]);
});

test("instanceof is false for non-instances, errors on a non-class RHS", () => {
  assert.deepEqual(run("class C {}\nprint(5 instanceof C)").out, ["false"]);
  assert.deepEqual(run("class C {}\nprint(null instanceof C)").out, ["false"]);
  assert.throws(
    () => run("print(5 instanceof 5)"),
    (e) => e instanceof LangError && /right-hand side of 'instanceof' must be a class/.test(e.langMessage),
  );
});

test("++ / -- : postfix yields the old value, prefix the new", () => {
  assert.deepEqual(run("let x = 5\nprint(x++)\nprint(x)").out, ["5", "6"]);
  assert.deepEqual(run("let x = 5\nprint(++x)\nprint(x)").out, ["6", "6"]);
  assert.deepEqual(run("let x = 5\nprint(x--)\nprint(x)").out, ["5", "4"]);
  assert.deepEqual(run("let x = 5\nprint(--x)\nprint(x)").out, ["4", "4"]);
});

test("++ / -- on object members and array indices", () => {
  assert.deepEqual(run("let o = { n: 1 }\no.n++\nprint(o.n)").out, ["2"]);
  assert.deepEqual(run("let a = [10]\nprint(a[0]++)\nprint(a[0])").out, ["10", "11"]);
  assert.deepEqual(run("let a = [10]\nprint(--a[0])").out, ["9"]);
});

test("++ in a C-style for loop", () => {
  assert.deepEqual(run("let s = 0\nfor (let i = 0; i < 5; i++) { s += i }\nprint(s)").out, ["10"]);
});

test("++ evaluates the target's index expression only once", () => {
  const src = [
    "let n = 0",
    "function idx() { n = n + 1; return 0 }",
    "let a = [10]",
    "a[idx()]++",
    "print(a[0])", // 11
    "print(n)",    // 1 -> idx() called once
  ].join("\n");
  assert.deepEqual(run(src).out, ["11", "1"]);
});

test("++ / -- require a numeric, assignable target", () => {
  assert.throws(
    () => run("let s = 'a'\ns++"),
    (e) => e instanceof LangError && e.phase === "runtime" && /cannot increment/.test(e.langMessage),
  );
  assert.throws(
    () => run("print(5++)"),
    (e) => e instanceof LangError && e.phase === "parse" && /requires a variable/.test(e.langMessage),
  );
});

// ---- async / await ----

// Compile + run a script that uses await, awaiting the unified run() (which
// returns a Promise once the script suspends). Returns { result, out, program, vm }.
async function runAsync(src, globals = {}, opts = {}) {
  const out = [];
  const vm = new Interpreter({ print: (s) => out.push(s) });
  vm.defineGlobals(globals);
  const program = vm.compile(src);
  const result = await program.run(opts);
  return { result, out, program, vm };
}

test("await resolves a host promise", async () => {
  const { out } = await runAsync("let x = await load()\nprint(x)", {
    load: () => Promise.resolve(42),
  });
  assert.deepEqual(out, ["42"]);
});

test("await on a non-promise returns it unchanged", async () => {
  assert.deepEqual((await runAsync("print(await 5)")).out, ["5"]);
  assert.deepEqual((await runAsync("print(await 'hi')")).out, ["hi"]);
});

test("awaited rejection surfaces as a runtime LangError", async () => {
  await assert.rejects(
    () => runAsync("await boom()", { boom: () => Promise.reject(new Error("kaboom")) }),
    (e) => e instanceof LangError && e.phase === "runtime" && /kaboom/.test(e.langMessage),
  );
});

test("call stack is intact after an awaited rejection", async () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ boom: () => Promise.reject(new Error("x")) });
  const program = vm.compile("function f() { return await boom() }\nawait f()");
  await assert.rejects(() => program.run(), (e) => e instanceof LangError);
  assert.equal(vm.evaluator.callStack.length, 0);
});

test("run() returns the value directly for a fully-synchronous script", () => {
  const vm = new Interpreter({ print: () => {} });
  const r = vm.compile("return 1 + 2").run();
  assert.equal(r, 3);
  assert.ok(!(r && typeof r.then === "function"), "sync script must not return a Promise");
});

test("run() transparently returns a Promise when the script awaits", async () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ load: () => Promise.resolve(99) });
  const pending = vm.compile("return await load()").run();
  assert.ok(pending && typeof pending.then === "function", "awaiting script returns a Promise");
  assert.equal(await pending, 99);
});

test("awaits do not consume fuel", async () => {
  // 50 awaits under a tiny step budget: only statement steps count.
  const src = "let s = 0\nfor (let i of range(50)) { s = s + await one() }\nprint(s)";
  const { out } = await runAsync(src, { one: () => Promise.resolve(1) }, { maxSteps: 1000 });
  assert.deepEqual(out, ["50"]);
});

test("await nested in expression position evaluates correctly", async () => {
  const g = { arr: () => Promise.resolve([1, 2, 3]), n: () => Promise.resolve(10) };
  assert.deepEqual((await runAsync("print(len(await arr()))", g)).out, ["3"]);
  assert.deepEqual((await runAsync("print(await n() + 1)", g)).out, ["11"]);
});

test("a promise is a first-class value and round-trips to the host", async () => {
  let received = null;
  const g = {
    make: () => Promise.resolve(7),
    take: (p) => { received = p; return p; }, // host gets a real thenable
  };
  const { out } = await runAsync("let p = make()\nprint(typeof p)\nprint(await take(p))", g);
  assert.deepEqual(out, ["promise", "7"]);
  assert.ok(received && typeof received.then === "function");
});

test("await a promise stored on a host object property", async () => {
  const engine = { pendingLoad: Promise.resolve("level1") };
  const { out } = await runAsync("print(await engine.pendingLoad)", { engine });
  assert.deepEqual(out, ["level1"]);
});

test("all() awaits a list of promises in order", async () => {
  const g = { a: () => Promise.resolve(1), b: () => Promise.resolve(2) };
  const { out } = await runAsync("let r = await all([a(), b(), 3])\nprint(r)", g);
  assert.deepEqual(out, ["[1, 2, 3]"]);
});

test("sleep() suspends and resumes", async () => {
  const { out } = await runAsync("print('before')\nawait sleep(1)\nprint('after')");
  assert.deepEqual(out, ["before", "after"]);
});

test("onStep counts statement steps only, not awaits", async () => {
  let steps = 0;
  // Three top-level statements; the two awaits must add zero steps.
  await runAsync("let a = await one()\nlet b = await one()\nlet c = 3", {
    one: () => Promise.resolve(1),
  }, { onStep: () => { steps++; } });
  assert.equal(steps, 3);
});

test("call() fires an async handler (returns a Promise)", async () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ fetch: (id) => Promise.resolve(id * 2) });
  const program = vm.compile("function onLoad(id) { return await fetch(id) }");
  program.run(); // define the handler (sync top level)
  const r = await program.call("onLoad", [21]);
  assert.equal(r, 42);
});

test("debugger refuses to step across await", () => {
  const vm = new Interpreter({ print: () => {} });
  vm.defineGlobals({ load: () => Promise.resolve(1) });
  const program = vm.compile("let x = await load()");
  const dbg = new Debugger(program).start();
  assert.throws(() => dbg.run(), (e) => e instanceof LangError && /await/.test(e.langMessage));
});
