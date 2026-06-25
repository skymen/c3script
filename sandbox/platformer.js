// A tiny 2D platformer that acts as the HOST engine for c3script. It exposes a
// `game` global (events + live player object) so scripts in the side editor can
// react to gameplay live. Click the game to play; click the editor to type.
//
// Controls: Left/Right arrows move, Up arrow (or Space) jumps. Spikes hurt.

import { C3Editor } from "./c3-monaco.js";
import { MathModule } from "../examples/stdlib-modules.mjs";

const SAMPLE = `// Live-test scripting against the platformer. Open the console (F12).
// Autocomplete: type  game.on("   for events, or  game.objects.player.  for the API.
let p = game.objects.player

// Make jumps extra springy by tweaking jump strength live.
p.jumpStrength = 15

game.on("jump", (e) => {
  log("jump! onGround=" + p.onGround)
})

game.on("land", (e) => {
  log("landed at x=" + Math.floor(p.x))
})

game.on("input", (e) => {
  // Press DOWN to ground-slam using setVelocity.
  if (e.key == "down") {
    p.setVelocity(0, 20)
    log("slam!")
  }
})

game.on("hurt", (e) => {
  log("ouch! -" + e.amount + " -> hp=" + e.hp)
  if (e.hp < 50) {
    p.hp = e.hp + 15                 // heal via the live bridge
    p.setPosition(30, 100)           // teleport back to start
    log("script healed + reset -> hp=" + p.hp)
  }
})
`;

export function startPlatformer(monaco) {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // --- world ---
  const platforms = [
    { x: 0, y: H - 24, w: W, h: 24 }, // ground
    { x: 120, y: H - 90, w: 90, h: 14 },
    { x: 300, y: H - 145, w: 90, h: 14 },
    { x: 470, y: H - 105, w: 110, h: 14 },
  ];
  const spikes = [
    { x: 232, y: H - 24 - 14, w: 40, h: 14 },
    { x: 400, y: H - 24 - 14, w: 50, h: 14 },
  ];
  const start = { x: 30, y: H - 24 - 24 };
  const player = {
    x: start.x, y: start.y, w: 20, h: 24,
    vx: 0, vy: 0, hp: 100, onGround: false,
    jumpStrength: 11, // scripts can tweak this live
  };
  // Methods exposed to scripts (in addition to the directly read/writable
  // fields above: x, y, vx, vy, hp, onGround, jumpStrength).
  player.setVelocity = (vx, vy) => { player.vx = vx; player.vy = vy; };
  player.setVelocityX = (vx) => { player.vx = vx; };
  player.setVelocityY = (vy) => { player.vy = vy; };
  player.setPosition = (x, y) => { player.x = x; player.y = y; };
  // Docs surfaced by the editor (completion panel + hover).
  player.__docs__ = {
    x: "Player x position (pixels). Read/write via the live bridge.",
    y: "Player y position (pixels).",
    hp: "Player health.",
    onGround: "True when the player is standing on a platform.",
    jumpStrength: "Upward speed applied on jump — raise it for springier jumps.",
    setVelocity: "Set both velocity components: `setVelocity(vx, vy)`.",
    setVelocityX: "Set horizontal velocity: `setVelocityX(vx)`.",
    setVelocityY: "Set vertical velocity: `setVelocityY(vy)`.",
    setPosition: "Teleport the player: `setPosition(x, y)`.",
  };
  const input = { left: false, right: false, up: false, down: false };

  // --- host-side event bus; safely invokes the current script's callbacks ---
  const bus = {
    map: new Map(),
    clear() { this.map.clear(); },
    on(channel, cb) {
      if (!this.map.has(channel)) this.map.set(channel, []);
      this.map.get(channel).push(cb);
    },
    emit(channel, data) {
      if (!currentProgram) return;
      for (const cb of this.map.get(channel) || []) {
        try {
          currentProgram.invoke(cb, [data]);
        } catch (e) {
          console.error(`script error in "${channel}":`, e.format ? e.format() : e);
        }
      }
    },
  };

  // --- globals exposed to scripts ---
  const game = {
    __events__: ["input", "jump", "land", "hurt", "tick"],
    __docs__: {
      on: "Listen for a game event: `on(event, callback)`. Events: input, jump, land, hurt, tick.",
      objects: "Live game objects (e.g. `game.objects.player`) — read/write their fields directly.",
      reset: "Reset the player to the start position.",
    },
    on: (event, cb) => bus.on(event, cb),
    objects: { player }, // live: scripts read/write player.x, player.hp, ...
    reset: () => resetPlayer(),
  };
  const globals = {
    game,
    // Namespaced module — a plain host object (see examples/stdlib-modules.mjs).
    Math: MathModule,
  };
  const argEnums = { "game.on": { 0: game.__events__ } };

  // --- editor (reusable wrapper) ---
  const editor = new C3Editor(document.getElementById("editor"), {
    monaco, globals, argEnums, source: SAMPLE,
  });

  let currentProgram = null;
  function runScript() {
    currentProgram = null;
    bus.clear();
    console.clear();
    console.log("--- script loaded ---");
    currentProgram = editor.run(); // registers listeners; null on error
  }
  document.getElementById("run").addEventListener("click", runScript);
  runScript();

  // --- physics ---
  const GRAVITY = 0.6;
  const MOVE = 3;
  const MAX_FALL = 14;
  let invuln = 0;
  let frame = 0;

  function resetPlayer() {
    player.x = start.x; player.y = start.y;
    player.vx = 0; player.vy = 0; player.hp = 100;
    invuln = 0;
  }

  const overlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  function tryJump() {
    if (player.onGround) {
      player.vy = -player.jumpStrength; // live-adjustable strength
      player.onGround = false;
      bus.emit("jump", {});
    }
  }

  function step() {
    frame++;

    // horizontal move + resolve
    player.vx = (input.right ? MOVE : 0) - (input.left ? MOVE : 0);
    player.x += player.vx;
    for (const p of platforms) {
      if (overlap(player, p)) {
        if (player.vx > 0) player.x = p.x - player.w;
        else if (player.vx < 0) player.x = p.x + p.w;
      }
    }

    // gravity + vertical move + resolve
    player.vy = Math.min(player.vy + GRAVITY, MAX_FALL);
    player.y += player.vy;
    const wasOnGround = player.onGround;
    player.onGround = false;
    for (const p of platforms) {
      if (overlap(player, p)) {
        if (player.vy > 0) { player.y = p.y - player.h; player.vy = 0; player.onGround = true; }
        else if (player.vy < 0) { player.y = p.y + p.h; player.vy = 0; }
      }
    }
    if (player.onGround && !wasOnGround) bus.emit("land", { x: player.x });

    // bounds / fall-out
    if (player.x < 0) player.x = 0;
    if (player.x + player.w > W) player.x = W - player.w;
    if (player.y > H + 40) resetPlayer();

    // spikes
    if (invuln > 0) invuln--;
    for (const s of spikes) {
      if (invuln === 0 && overlap(player, s)) {
        player.hp -= 20;
        invuln = 45;
        player.vy = -7; // little knockback
        bus.emit("hurt", { amount: 20, hp: player.hp });
        if (player.hp <= 0) resetPlayer();
        break;
      }
    }

    bus.emit("tick", { frame, onGround: player.onGround });
  }

  // --- render ---
  function drawSpikes(s) {
    const n = Math.max(1, Math.floor(s.w / 10));
    const tw = s.w / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = s.x + i * tw;
      ctx.moveTo(x, s.y + s.h);
      ctx.lineTo(x + tw / 2, s.y);
      ctx.lineTo(x + tw, s.y + s.h);
    }
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#30363d";
    for (const p of platforms) ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#f85149";
    for (const s of spikes) drawSpikes(s);
    // player (blinks while invulnerable)
    ctx.fillStyle = invuln > 0 && (frame >> 2) % 2 ? "#8b949e" : "#58a6ff";
    ctx.fillRect(player.x, player.y, player.w, player.h);
    // HUD
    ctx.fillStyle = "#fff";
    ctx.font = "14px monospace";
    ctx.fillText("HP: " + player.hp, 10, 18);
    ctx.fillStyle = "#8b949e";
    ctx.fillText("click here, then: ← → move, ↑/Space jump", 10, H - 8);
  }

  function loop() {
    step();
    draw();
    requestAnimationFrame(loop);
  }
  loop();

  // --- input (bound to the canvas so it doesn't steal keys from the editor) ---
  const KEY = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    a: "left", d: "right", w: "up", s: "down", " ": "up",
  };
  canvas.tabIndex = 0; // focusable
  canvas.addEventListener("mousedown", () => canvas.focus());
  canvas.addEventListener("keydown", (e) => {
    const k = KEY[e.key];
    if (!k) return;
    e.preventDefault();
    if (!input[k]) {
      input[k] = true;
      bus.emit("input", { key: k });
      if (k === "up") tryJump();
    }
  });
  canvas.addEventListener("keyup", (e) => {
    const k = KEY[e.key];
    if (!k) return;
    e.preventDefault();
    input[k] = false;
  });
}
