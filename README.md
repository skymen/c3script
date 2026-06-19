# c3script

A small, sandboxed, dynamically-typed, **JS-like** scripting language for level
editors (or any embedding host). It's a custom language — *not* JS — implemented
as a generator-based tree-walking interpreter in pure JS, with **zero runtime
dependencies**. Scripts can only touch the host through globals you explicitly
register, so it is sandboxed by construction.

## Why this design

- **Custom language, JS-like syntax** — you control the surface; nothing executes
  unless the interpreter implements it.
- **Host-agnostic** — the core knows nothing about the editor. All integration
  goes through one file (`src/host.js`). Drop it into Construct 3, a browser app,
  Electron, etc.
- **Generator-based evaluator** — each statement `yield`s a checkpoint, which
  gives pause/step/breakpoints and an infinite-loop "fuel" limit almost for free
  (see `src/debugger.js`).

## Quick start

```js
import { Interpreter } from "./src/index.js";

const vm = new Interpreter();
vm.defineGlobals({
  spawn: (type, x, y) => editor.spawn(type, x, y),
  setTile: (x, y, t) => editor.setTile(x, y, t),
  // namespaced/nested objects work too (live bridge):
  engine: {
    objects: editor.objects,                 // engine.objects.hero.hp (live)
    destroy: (id) => editor.destroy(id),      // engine.destroy("hero")
  },
});

const program = vm.compile(sourceCode);
program.run();                  // execute top level (defines functions/handlers)
program.call("onClick", [id]);  // fire an event handler later (state persists)
```

Run `npm run demo` for a full end-to-end demo (mock editor), `npm test` for the
test suite, and `npm run repl` for an interactive prompt.

## Language

Dynamically typed. Values: number, string, bool, `null`, array, object/map,
function (closure), class, instance.

```js
// comments: // line   /* block */
let x = 5
const name = "world"

function greet(who) { return "hi " + who }     // functions
let add = (a, b) => a + b                       // arrows / closures

let list = [1, 2, 3]                            // arrays
let obj  = { hp: 100, tags: ["enemy"] }         // objects
obj.hp -= 10
list.push(4)

if (x > 3 && name != "") { print("ok") } else { print("no") }
for (let i = 0; i < list.len; i = i + 1) { print(list[i]) }
for (let item of list) { print(item) }
while (x > 0) { x = x - 1 }

class Enemy {
  constructor(hp) { this.hp = hp }
  hurt(n) { this.hp = this.hp - n; return this }
}
let e = new Enemy(30)
e.hurt(5).hurt(5)

// inheritance: extends + super
class Boss extends Enemy {
  constructor(hp, name) { super(hp); this.name = name }
  hurt(n) { return super.hurt(n * 2) }   // bosses take double damage
}

// nested functions / function expressions close over their scope
function makeAdder(x) {
  function add(y) { return x + y }
  return add
}
```

**Operators:** `+ - * / %`, `== != < <= > >=`, `&& || !`, `? :`, assignment
`= += -= *= /=`. **Truthiness:** `null`/`false`/`0`/`""` are falsy.

**Built-ins:** `print`, `len`, `keys`, `type`, `str`, `num`, `bool`, `range`,
and math (`abs floor ceil round sqrt min max pow`). Arrays have
`len/push/pop/indexOf/join/slice`; strings have `len/upper/lower/slice/indexOf/split/contains`.

## Host integration (`src/host.js`)

- `defineGlobal(name, value, options?)` / `defineGlobals({...}, options?)` register
  host values.
- Functions become callable; arguments are marshalled to plain JS and return
  values back to script values.
- Nested plain objects are exposed via a **live bridge**: `engine.objects.hero.hp`
  always reads current host state, and writes propagate back to JS. Writing a key
  that doesn't exist creates it — so a registered `global = {}` works as a
  **shared scope** across script instances (they share the registered globals).
- **Write policy** via `options`: `{ writable: false }` makes an object read-only
  to scripts; `{ extensible: false }` allows updating existing keys but rejects new
  ones. Both default to `true`. The policy propagates to nested objects.
- Only what you register is reachable — the sandbox boundary lives in this one file.

### Calling into scripts

```js
program.run();                       // run top level (defines functions/handlers)
program.call("onClick", [id]);       // call a top-level function
program.call("player.attack", []);   // dotted path -> method call, `this` bound
program.has("onSpawn");              // does this callable exist?
program.invoke(fnValue, [data]);     // call a function VALUE the script handed you
```

### Event listeners

Scripts can register callbacks with host objects and the engine fires them later.
The host stores the callback (a script function value) and calls it with
`program.invoke(cb, [eventData])`. See `examples/events.mjs`:

```js
// host side
const player = { on: (ev, cb) => bus.on("player:" + ev, cb) };
vm.defineGlobals({ game: { on, objects: { player } }, log });
// ...later, when an event happens:
bus.emit("player:hurt", { amount: 30 });  // -> program.invoke(storedCb, [data])
```
```js
// script side
game.on("input", (input) => { log("key " + input.key) })
game.objects.player.on("hurt", (e) => { hp = hp - e.amount })
```

## Debugging (`src/debugger.js`)

```js
import { Debugger } from "./src/index.js";
const dbg = new Debugger(program).start();
dbg.addBreakpoint(7);
dbg.resume();      // run to line 7
dbg.locals();      // { i: 3, total: 6 }
dbg.stack();       // [{ name, line }, ...]
dbg.step();        // advance one statement
```

Runaway scripts are stopped by a step budget: `program.run({ maxSteps: 100000 })`.

## Files

| File | Role |
|---|---|
| `src/lexer.js` | source → tokens (with line/column) |
| `src/parser.js` | tokens → AST (Pratt expressions) |
| `src/ast.js` | node factory / type list |
| `src/values.js` | runtime value types + helpers |
| `src/environment.js` | lexical scope chain |
| `src/interpreter.js` | generator-based evaluator |
| `src/host.js` | host-binding layer + marshalling (the sandbox boundary) |
| `src/stdlib.js` | built-in functions |
| `src/debugger.js` | step / breakpoints / inspection |
| `src/index.js` | public API (`Interpreter`, `Program`, `Debugger`) |

## Notes / limitations

- Semicolons are optional; avoid starting a line with `(` or `[` right after an
  expression statement (it parses as a call/index of the previous line).
- Loop variables use one binding per loop (not per-iteration), so closures
  created in a loop share the final value.
- Classes support single inheritance (`extends` + `super`). `super(...)` calls the
  parent constructor; `super.method(...)` calls the parent's method.
