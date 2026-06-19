// Event-listening demo. A host-side event bus stores the callbacks scripts
// register, then the "engine" fires events and the stored script callbacks run
// via program.invoke(). Shows both game-scope and object-scope listeners.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Interpreter } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");

// --- A tiny host-side event bus ---------------------------------------------
class EventBus {
  constructor() {
    this.listeners = new Map();
  }
  on(channel, cb) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, []);
    this.listeners.get(channel).push(cb);
  }
  emit(channel, data) {
    console.log(`\nemit ${channel}`, data ?? "");
    for (const cb of this.listeners.get(channel) || []) {
      program.invoke(cb, [data]); // call the stored script callback
    }
  }
}

const bus = new EventBus();

// --- Host objects exposed to scripts ----------------------------------------
// `on` returns nothing; it just records the callback in the bus. Each object
// namespaces its own channel.
const player = {
  hp: 100,
  on: (event, cb) => bus.on("player:" + event, cb),
};
const game = {
  on: (event, cb) => bus.on("game:" + event, cb),
  objects: { player },
};

const vm = new Interpreter();
vm.defineGlobals({
  game,
  log: (msg) => console.log("  [script]", msg),
});

const program = vm.compile(read("events.script"));
program.run(); // run top level once -> registers all listeners

// --- The "engine" now fires events; script callbacks run --------------------
bus.emit("game:input", { key: "Space" });
bus.emit("player:jump", { height: 12 });
bus.emit("player:hurt", { amount: 30 });
bus.emit("player:hurt", { amount: 30 });
bus.emit("player:hurt", { amount: 50 }); // hp hits 0 -> "player died!"

// You can also call a named handler directly.
console.log("\ncall onReset() directly:");
program.call("onReset");
