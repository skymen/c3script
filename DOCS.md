# c3script — Full Documentation

c3script is a small, dynamically-typed, **JavaScript-like** scripting language
designed to be embedded in a host application (such as a level editor) and run
untrusted scripts safely. It is **not** JavaScript: it's a custom language
implemented as a generator-based tree-walking interpreter in pure JS, with no
runtime dependencies. Scripts can only interact with the host through values you
explicitly register.

---

## Table of contents

1. [Concepts & mental model](#1-concepts--mental-model)
2. [Embedding the interpreter (host API)](#2-embedding-the-interpreter-host-api)
3. [Exposing things to scripts](#3-exposing-things-to-scripts)
4. [Calling into scripts & event listeners](#4-calling-into-scripts--event-listeners)
5. [Language reference](#5-language-reference)
6. [Built-in functions](#6-built-in-functions)
7. [Errors](#7-errors)
8. [Debugging](#8-debugging)
9. [Security model](#9-security-model)
10. [Editor integration](#10-editor-integration)
11. [Limitations & gotchas](#11-limitations--gotchas)
12. [API cheat-sheet](#12-api-cheat-sheet)

---

## 1. Concepts & mental model

There are two worlds:

- **Host world** — your JavaScript application (the editor/engine). You create an
  `Interpreter`, register globals, and compile/run scripts.
- **Script world** — the sandboxed program text written in c3script.

Values crossing the boundary are **marshalled** (translated) automatically. The
boundary is the only way scripts touch the host: a script cannot reach any JS
object, function, or global you didn't register.

A typical lifecycle:

```js
import { Interpreter } from "./src/index.js";

const vm = new Interpreter();          // 1. create
vm.defineGlobals({ spawn, engine });   // 2. expose host capabilities
const program = vm.compile(sourceCode);// 3. parse a script into a reusable Program
program.run();                         // 4. execute its top level
program.call("onClick", [id]);         // 5. (optional) invoke handlers later
```

---

## 2. Embedding the interpreter (host API)

### Creating an interpreter

```js
const vm = new Interpreter({
  stdlib: true,        // install built-ins (print, len, range, math…). Default true.
  print: (text) => {}, // where print() output goes. Default console.log.
});
```

Passing `print` is the clean way to capture script output (for a console pane,
tests, logging, etc.).

### Compiling and running

```js
const program = vm.compile(source);  // parse once -> reusable Program (own top-level scope)
program.run();                       // run the top-level statements

// convenience: compile + run in one step
vm.run(source);
```

`compile()` parses the source and returns a `Program` with **its own top-level
scope** (sharing the interpreter's registered globals). Compiling the same source
twice gives two independent programs — useful for attaching a behavior script to
many objects, each with its own persistent state.

`run()` / `call()` / `invoke()` accept options:

```js
program.run({ maxSteps: 1_000_000, onStep: (cp) => {} });
```

- `maxSteps` — the "fuel" budget. Each statement counts as a step; exceeding the
  budget aborts with a `LangError` (infinite-loop protection). Default `1_000_000`.
- `onStep(checkpoint)` — called before each statement; `checkpoint` is
  `{ line, kind, env }`. Useful for tracing.

#### Async execution

`run()` / `call()` / `invoke()` work the same whether or not a script uses
`await` (see [Async / await](#async--await)). A fully-synchronous script returns
its value directly; a script that suspends on `await` returns a JS `Promise`.
You can therefore always `await` the result — awaiting a plain value is a no-op:

```js
const n = program.run();              // sync script -> the value
const n = await program.run();        // async script -> the resolved value
                                      //   (and harmless if the script was sync)
await program.call("onLoad", [id]);   // an async event handler
```

So host code that might run async scripts should just `await` the call; there is
no separate async API to choose, and no "wrong method" runtime error.

---

## 3. Exposing things to scripts

Everything a script can see is what you register as a global.

### Simple values and functions

```js
vm.defineGlobal("PI", 3.14159);
vm.defineGlobal("spawn", (type, x, y) => editor.spawn(type, x, y));

vm.defineGlobals({
  setTile: (x, y, t) => editor.setTile(x, y, t),
  maxHp: 100,
});
```

- A registered **function** becomes callable from scripts. Its arguments are
  marshalled from script values to plain JS, and its return value is marshalled
  back.
- A registered **primitive** is just a value.

### Namespaced / nested objects (the live bridge)

Register a single object tree and scripts address it with dotted paths:

```js
vm.defineGlobals({
  engine: {
    objects: { hero: { hp: 100 } },         // engine.objects.hero.hp
    spawn: (type, x, y) => editor.spawn(...),// engine.spawn("goblin", 0, 0)
  },
});
```

```js
// in a script:
engine.objects.hero.hp = engine.objects.hero.hp - 10   // writes back to the real object
engine.spawn("goblin", 0, 0)
```

This is a **live bridge**: reads always reflect the current host state, and writes
propagate back to your JS object. Methods keep their `this`.

**Important:** only **own** properties are visible, and `__proto__` / `constructor`
/ `prototype` are blocked (see [Security](#9-security-model)). If you expose a
**class instance** whose methods live on the prototype, those methods won't be
callable from scripts — expose methods as own properties instead:

```js
const player = { hp: 100 };
player.hurt = (n) => { player.hp -= n; };   // own property -> callable from scripts
```

### Controlling write access

```js
vm.defineGlobal("config", { speed: 5 }, { writable: false });   // read-only
vm.defineGlobal("state",  { hp: 10 },   { extensible: false }); // can update keys, can't add new ones
```

- `writable: false` — scripts cannot modify the object at all.
- `extensible: false` — scripts can change existing keys but cannot add new ones.
- Both default to `true`. The policy propagates to nested objects.

### Shared scope between scripts

Because writing a missing key creates it, a single registered object works as a
shared scratch space across multiple programs:

```js
const shared = {};
vm.defineGlobals({ global: shared });   // every program sees the same object
```

```js
global.score = (global.score == null ? 0 : global.score) + 1
```

---

## 4. Calling into scripts & event listeners

### Calling a named function or method

After `program.run()` has executed the top level (defining functions), you can
call them:

```js
program.call("onClick", [objectId]);     // top-level function
program.call("player.attack", []);        // dotted path -> method, `this` bound
program.has("onSpawn");                    // does this callable exist?
```

Arguments are passed as host values and marshalled into the script. The return
value is the script's value.

### Event-listener pattern

The common pattern: a script registers a callback with a host object, and the host
fires it later. The callback is a **script function value**; the host stores it
and calls it back with `program.invoke()`:

```js
// host side
const bus = new Map();
const game = {
  on: (event, cb) => { (bus.get(event) ?? bus.set(event, []).get(event)).push(cb); },
  objects: { player: { hp: 100 } },
};
vm.defineGlobals({ game, log: (m) => console.log(m) });

const program = vm.compile(source);
program.run();                       // registers the listeners

// when something happens:
for (const cb of bus.get("jump") ?? []) {
  program.invoke(cb, [{ height: 12 }]);   // fire the stored callback
}
```

```js
// script side
game.on("jump", (e) => { log("jumped " + e.height) })
game.on("hurt", (e) => { game.objects.player.hp = game.objects.player.hp - e.amount })
```

- `program.invoke(fnValue, args, opts)` calls any callable script value. Use it for
  stored callbacks; use `program.call(name, args)` when you only know the name.
- Top-level state persists across invocations, so listeners can accumulate state.

See `examples/events.mjs` and `sandbox/platformer.js` for full working hosts.

---

## 5. Language reference

c3script looks like JavaScript. Dynamic typing; the value types are: **number**
(double), **string**, **bool**, **null**, **array**, **object** (map), **function**,
**class**, and **instance**.

### Comments

```js
// line comment
/* block
   comment */
```

### Variables

```js
let x = 5
let y          // defaults to null
const TAU = 6.28   // const must be initialized and cannot be reassigned
x = x + 1
```

### Literals

```js
42        3.14      1e3          // numbers
"hi"      'also ok'              // strings (escapes: \n \t \r \\ \" \' \0)
true      false      null        // bool / null
[1, 2, 3]                        // array
{ name: "x", hp: 100 }           // object (keys: identifier, string, or number)
```

### Operators

| Category    | Operators | Notes |
|-------------|-----------|-------|
| Arithmetic  | `+ - * / %` | `/` follows JS (division by zero → `Infinity`) |
| String      | `+` | if either side is a string, both are stringified and concatenated |
| Comparison  | `< <= > >=` | numbers, or strings (lexicographic) |
| Equality    | `== !=` | primitives by value; arrays/objects/instances by reference; `null == null` |
| Logical     | `&& \|\| !` | `&&`/`\|\|` return an operand value (JS-like), not a forced bool |
| Ternary     | `cond ? a : b` | |
| Unary       | `-x  !x  typeof x` | `typeof` yields a type-name string (see below) |
| Type test   | `x instanceof Class` | true if `x` is an instance of `Class` or a subclass |
| Increment   | `x++  ++x  x--  --x` | numeric target only; postfix yields the old value, prefix the new |
| Assignment  | `=  +=  -=  *=  /=` | targets: variable, `obj.prop`, `arr[i]` |

`typeof x` returns one of: `"number"`, `"string"`, `"bool"`, `"null"`, `"array"`,
`"object"`, `"function"`, `"class"`, `"instance"`, `"promise"`. `instanceof` only
tests user-defined classes (its right side must be a class); host objects and
primitives are not instances of anything.

```js
if (typeof p == "promise") { p = await p }   // detect an un-awaited promise

class Enemy {}
class Boss extends Enemy {}
let b = new Boss()
b instanceof Boss     // true
b instanceof Enemy    // true (walks the inheritance chain)
new Enemy() instanceof Boss   // false (an Enemy is not a Boss)
5 instanceof Enemy            // false (not an instance of anything)
```

**Truthiness:** `null`, `false`, `0`, `""`, and `NaN` are falsy; everything else is
truthy.

### Control flow

```js
if (x > 0) { ... } else if (x < 0) { ... } else { ... }

while (cond) { ...; break; ...; continue }

for (let i = 0; i < 10; i++) { ... }         // C-style

for (let item of list) { ... }               // for-of: arrays, strings, host arrays
```

`break` and `continue` work in all loops. (`for-of` iterates arrays, strings —
character by character — and host arrays. It does not iterate plain objects; use
`keys(obj)`.)

### Async / await

`await <expr>` suspends the script until a promise settles, then resumes with the
resolved value. Promises come from the host (a host function that returns a JS
`Promise`) or from the `sleep` / `all` built-ins. `await` on a non-promise just
returns the value unchanged (as in JS).

```js
let data = await engine.load("level1")   // await a host promise
await sleep(100)                          // pause 100ms
let both = await all([loadA(), loadB()])  // wait for several at once
```

There is no `async` keyword — `await` is allowed in any function (or at the top
level). You don't pick a special entry point: `run()` / `call()` / `invoke()`
return a `Promise` automatically when a script suspends on `await`, so just
`await` the result (see [Async execution](#async-execution)).

A promise is a first-class value: you can store it, pass it to a host function
(the host receives a real thenable), and `typeof p` reports `"promise"`.

Because the language has no `try`/`catch`, a **rejected** awaited promise
propagates out as a `LangError` to the host — scripts cannot catch it.

### Functions and closures

```js
function add(a, b) { return a + b }     // declaration (can be nested inside functions)

let mul = (a, b) => a * b               // arrow with expression body (implicit return)
let f = (x) => { return x * 2 }         // arrow with block body
let g = function (n) { return n + 1 }   // function expression

// closures capture their defining scope:
function makeCounter() {
  let n = 0
  return function () { n = n + 1; return n }
}
let c = makeCounter()
c()   // 1
c()   // 2
```

- Missing arguments are `null`; extra arguments are ignored.
- Functions are first-class values: pass them around, return them, store them.

### Arrays

```js
let a = [10, 20, 30]
a[0]            // 10
a.len           // 3   (also a.length)
a[5] = 99       // grows the array
a.push(40)      // append; returns new length
a.pop()         // remove & return last (or null if empty)
a.indexOf(20)   // 1
a.join(", ")    // "10, 20, 30, 40"
a.slice(1, 3)   // [20, 30]
```

Indices must be integers; reading out of range returns `null`.

### Strings

```js
let s = "Hello"
s.len            // 5  (also s.length)
s[0]             // "H"
s.upper()        // "HELLO"
s.lower()        // "hello"
s.slice(1, 3)    // "el"
s.indexOf("l")   // 2
s.split("l")     // ["He", "", "o"]
s.contains("ell")// true
```

### Objects

```js
let o = { hp: 100, name: "boss" }
o.hp             // 100
o["name"]        // "boss"  (index access)
o.mana = 50      // add / set
o.missing        // null    (reading a missing key returns null, never an error)
```

### Classes & inheritance

```js
class Enemy {
  constructor(hp) { this.hp = hp }
  hurt(n) { this.hp = this.hp - n; return this }   // returning `this` enables chaining
}

class Boss extends Enemy {
  constructor(hp, name) {
    super(hp)            // call the parent constructor
    this.name = name
  }
  hurt(n) { return super.hurt(n * 2) }   // call the parent method
}

let b = new Boss(100, "Dragon")
b.hurt(5).hurt(5)
b.hp        // 80
b.name      // "Dragon"
```

- Single inheritance via `extends`. `super(...)` invokes the parent constructor;
  `super.method(...)` invokes the parent's method. Method and constructor lookup
  walk the inheritance chain.
- `this` refers to the instance inside methods/constructors.
- Reading a missing field returns `null`; user fields and methods are isolated
  from JS internals (e.g. `instance.constructor` is `null`, not the JS class).

---

## 6. Built-in functions

Installed by default (`stdlib: true`). They operate directly on script values.

| Function | Description |
|----------|-------------|
| `print(...args)` | Print values separated by spaces (goes to the host's `print`). |
| `len(x)` | Length of an array/string, or number of keys in an object. |
| `keys(obj)` | Array of an object's keys. |
| `str(x)` | Convert any value to its string form. |
| `num(x)` | Convert to a number (returns `null` if not numeric). |
| `bool(x)` | Truthiness of `x` as a bool. |
| `range(n)` / `range(a, b)` / `range(a, b, step)` | Array of numbers (like Python's `range`). |
| `abs ceil floor round sqrt` | Math, one argument. |
| `min(...n)` `max(...n)` `pow(a, b)` | Math. |
| `sleep(ms)` | Returns a promise that resolves after `ms` milliseconds. `await` it. |
| `all(arr)` | Returns a promise resolving to an array of the awaited elements. |

```js
let total = 0
for (let i of range(5)) { total = total + i }   // 0+1+2+3+4 = 10
print("sum:", total)
```

---

## 7. Errors

All failures throw a `LangError` carrying a phase, source position, and (for
runtime errors) a script call stack.

```js
import { LangError } from "./src/index.js";
try {
  vm.run(source);
} catch (e) {
  if (e instanceof LangError) {
    console.error(e.format());   // "runtime error at line 3: ...\n  at f (line 2)\n  ..."
    e.phase;        // "lex" | "parse" | "runtime"
    e.line;         // line number (or null)
    e.column;       // column (or null)
    e.langMessage;  // the message without the position prefix
    e.scriptStack;  // [{ name, line }, ...] for runtime errors
  }
}
```

Example formatted output:

```
runtime error at line 1: undefined variable 'missing'
  at boom (line 2)
  at outer (line 3)
```

---

## 8. Debugging

The interpreter is generator-based, so single-stepping, breakpoints, and
inspection come almost for free via the `Debugger`.

```js
import { Debugger } from "./src/index.js";

const dbg = new Debugger(program, { maxSteps: 1_000_000 }).start();
dbg.addBreakpoint(7);     // pause whenever line 7 is about to execute

dbg.resume();             // run to the next breakpoint (or end)
dbg.line;                 // current line
dbg.locals();             // { i: 3, total: 6 } — locals at the pause point
dbg.value("total");       // read one variable
dbg.stack();              // [{ name, line }, ...] call stack
dbg.describe();           // one-line snapshot string

dbg.step();               // advance one statement (returns checkpoint or null at end)
dbg.run();                // run to completion, returns the result
dbg.removeBreakpoint(7);
```

`run({ maxSteps })` on a `Program` is the simpler tool when you only need
infinite-loop protection rather than stepping.

---

## 9. Security model

The guarantee: a script can only touch the host through values you register, and
cannot reach the host's JS internals or run arbitrary JS.

- **Live bridge exposes own properties only**, and **blocks** `__proto__`,
  `constructor`, and `prototype` (read returns `null`; write throws). This prevents
  prototype-chain climbing to `Object`/`Function`/`globalThis`, the
  `x.constructor.constructor("…")()` RCE gadget, and prototype pollution.
- **Function values are not member-accessible** — `someFn.constructor` throws — so
  there is no path from a function to `Function`/`eval`.
- **Marshalling never emits dangerous keys** and rejects cyclic structures.
- **Denial-of-service fails gracefully**: runaway recursion, cyclic values, and
  pathologically nested source all surface as a `LangError`; the `maxSteps` budget
  bounds loops.
- **Per-global write policy** (`writable` / `extensible`) further restricts mutation.

Run the security regression probe any time you extend the host bridge:

```
node examples/sandbox-escape.mjs
```

If you add member access on function values, or expose inherited members, re-run
it — those are the changes most likely to reopen an escape.

---

## 10. Editor integration

`src/editor-support.js` provides framework-agnostic helpers (return plain data, no
editor dependency) for building autocomplete and diagnostics:

- `completionPath(prefix)` — dotted path being typed.
- `memberSuggestions(path, { globals, source })` — members to offer after a dot. It
  resolves the root through inferred local-variable types first, then the live
  globals graph.
- `inferLocalTypes(source)` / `classMembers(source, name)` — lightweight type
  inference: maps top-level `let p = game.objects.player` (and array/string/`new
  Class()` initializers) so `p.` completes the right members.
- `resolvePathValue(globals, path)` / `describeObject(obj)` — reflect members; a
  sibling `__docs__` map on an object supplies per-member doc strings.
- `docFor(globals, docsSchema, path, name)` — resolve a member's doc, preferring an
  explicit `docs` schema (keyed by dotted path) over the `__docs__` convention.
- `callContextAt(prefix)` / `enumValuesFor(...)` — detect the cursor is inside a
  string argument and resolve enum values (e.g. `game.on("…")`), from a schema or an
  `__events__` array on the host object.
- `collectScriptSymbols(source)` — the user's own declared names.
- `BUILTINS` / `KEYWORDS` — stdlib names and language keywords.

A ready-made Monaco wrapper lives in `sandbox/c3-monaco.js`:

```js
const ed = new C3Editor(container, { monaco, globals, argEnums, docs, source });
const program = ed.run();   // compile + run; errors go to the console
```

It registers c3script as its **own** Monaco language (dedicated tokenizer + config,
so no JavaScript IntelliSense competes with it), and wires up live parse
diagnostics, member completion (globals + inferred local types), contextual
string-argument enums, and prop docs shown in completion and on hover (via a
`docs` schema or `__docs__` on the host objects). The browser sandboxes
(`npm run sandbox`) show it in action, including a playable platformer that scripts
react to live.

---

## 11. Limitations & gotchas

- **Semicolons are optional**, but don't start a line with `(` or `[` right after
  an expression statement — it parses as a call/index of the previous line. Add a
  semicolon if needed.
- **Loop variables use one binding per loop** (not per-iteration), so closures
  created inside a loop share the final value.
- **`extends` takes a left-hand-side expression** (identifier, member, or call —
  e.g. `extends Base`, `extends pkg.Base`, `extends mixin(Base)`), not an arbitrary
  expression with operators.
- **Host class instances**: only own-property methods are callable from scripts;
  prototype methods are not visible through the live bridge.
- **Host arrays** exposed via the bridge support read / index / iterate / `len`,
  but not mutation methods like `push` (convert to a script array, or expose a
  method). Script-created arrays support all the array methods.
- **No `try`/`catch`** in the language; errors propagate to the host as `LangError`.
  This includes a **rejected** awaited promise — scripts cannot catch it.
- **`await` makes the result a Promise** — `run()` / `call()` / `invoke()` return a
  `Promise` when (and only when) a script suspends on `await`; otherwise they return
  the value directly. `await` the call if it might be async. The **debugger** cannot
  step across an `await`.
- **No modules/imports** in scripts; a program is a single source string.

---

## 12. API cheat-sheet

```js
import {
  Interpreter, Program, Debugger, LangError,
  parse, tokenize, stringify, typeName,
  scriptToHost, hostToScript,
} from "./src/index.js";

// --- Interpreter ---
const vm = new Interpreter({ stdlib: true, print: console.log });
vm.defineGlobal(name, value, { writable, extensible });
vm.defineGlobals(obj, { writable, extensible });
const program = vm.compile(source);
vm.run(source, opts);                    // compile + run

// --- Program ---
program.run({ maxSteps, onStep });       // execute top level (Promise if it awaits)
program.call(nameOrPath, args, opts);    // call function/method by name (this-bound)
program.invoke(fnValue, args, opts);     // call a function value (stored callback)
// run/call/invoke return a Promise iff the script suspends on `await`; otherwise
// the value directly. Safe to `await` either way.
program.has(nameOrPath);                 // does a callable exist?
program.generator();                     // low-level generator (for Debugger)

// --- Debugger ---
const dbg = new Debugger(program, { maxSteps }).start();
dbg.addBreakpoint(line); dbg.removeBreakpoint(line);
dbg.step(); dbg.resume(); dbg.run();
dbg.line; dbg.locals(); dbg.value(name); dbg.stack(); dbg.describe();

// --- Errors ---
e instanceof LangError;
e.phase; e.line; e.column; e.langMessage; e.scriptStack; e.format();
```

---

*For a quick overview and runnable examples, see [README.md](README.md). For the
language internals, the source under `src/` is small and commented.*
