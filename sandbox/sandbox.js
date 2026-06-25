// Sandbox wiring: defines example host globals (with an event bus), creates a
// C3Editor, and hooks up the Run button. All logs go to the browser console.

import { C3Editor } from "./c3-monaco.js";
import { MathModule } from "../examples/stdlib-modules.mjs";

const SAMPLE = `// c3script sandbox — open the browser console (F12) for output.
// Try autocomplete:
//   type  game.        -> members of the game object
//   type  game.on("    -> the valid event names (input/tick/pause)
//   type  game.objects.player.on("   -> player events (jump/hurt/land)

let hp = 100

game.on("input", (e) => {
  log("input: " + e.key)
})

game.objects.player.on("jump", (e) => {
  log("player jumped, height=" + e.height)
})

game.objects.player.on("hurt", (e) => {
  hp = hp - e.amount
  log("player hurt -" + e.amount + " -> hp=" + hp)
})
`;

export function startSandbox(monaco) {
  // --- host-side event bus ---
  const bus = {
    map: new Map(),
    clear() { this.map.clear(); },
    on(channel, cb) {
      if (!this.map.has(channel)) this.map.set(channel, []);
      this.map.get(channel).push(cb);
    },
    emit(program, channel, data) {
      for (const cb of this.map.get(channel) || []) program.invoke(cb, [data]);
    },
  };

  // --- host objects exposed to scripts ---
  // `__events__` is metadata the autocomplete reflects (and the runtime ignores).
  const player = {
    hp: 100,
    __events__: ["jump", "hurt", "land"],
    __docs__: {
      hp: "Player health, 0–100.",
      on: "Listen for a player event: `on(event, callback)`. Events: jump, hurt, land.",
    },
    on: (event, cb) => bus.on("player:" + event, cb),
  };
  const game = {
    __events__: ["input", "tick", "pause"],
    __docs__: {
      on: "Listen for a game event: `on(event, callback)`. Events: input, tick, pause.",
      spawn: "Spawn an object into the level: `spawn(type, x, y)`.",
      objects: "Live game objects, addressable by id (e.g. `game.objects.player`).",
    },
    on: (event, cb) => bus.on("game:" + event, cb),
    spawn: (type, x, y) => console.log("[host] spawn", type, x, y),
    objects: { player },
  };

  const globals = {
    game,
    // A namespaced module is just a host object (see examples/stdlib-modules.mjs).
    // Putting it in `globals` makes Math.* both runnable and autocompletable.
    Math: MathModule,
  };

  // Optional explicit schema (equivalent here to the __events__ convention).
  const argEnums = {
    "game.on": { 0: game.__events__ },
    "game.objects.player.on": { 0: player.__events__ },
  };

  const editor = new C3Editor(document.getElementById("editor"), {
    monaco, globals, argEnums, source: SAMPLE,
  });

  document.getElementById("run").addEventListener("click", () => {
    console.clear();
    bus.clear();
    console.log("--- running ---");
    const program = editor.run(); // top level registers listeners
    if (!program) return;

    // Fire some demo events so the listeners produce console output.
    bus.emit(program, "game:input", { key: "Space" });
    bus.emit(program, "player:jump", { height: 12 });
    bus.emit(program, "player:hurt", { amount: 30 });
    bus.emit(program, "player:hurt", { amount: 25 });
    console.log("--- done ---");
  });
}
