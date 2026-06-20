// Browser tests for the Monaco editor integration (sandbox/c3-monaco.js).
// These drive a REAL headless Chromium against the running sandbox — the only
// way to verify completion/hover behavior, which unit tests and mocked-Monaco
// harnesses miss (see: the callContextAt string-detection bug).
//
// Kept OUT of the pure-language suite: the file lives outside test/ and is not
// named *.test.mjs, so `npm test` (node --test) never auto-discovers it.
// Run explicitly:  npm run test:editor
//
// Requires the `playwright` devDependency and its Chromium:
//   npx playwright install chromium

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
let server, browser, page;

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server did not start: ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  server = spawn("node", ["sandbox/serve.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitForServer(`${BASE}/sandbox/platformer.html`);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.goto(`${BASE}/sandbox/platformer.html`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 15000 });
  await page.waitForTimeout(1000);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

// Set the editor to `script`, place the cursor at the end, type `trigger`
// (usually "." or '"'), and return the visible suggestion labels.
async function suggestionsAfter(script, trigger) {
  await page.keyboard.press("Escape");
  await page.evaluate((s) => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setValue(s);
    const m = ed.getModel();
    const line = m.getLineCount();
    ed.setPosition({ lineNumber: line, column: m.getLineMaxColumn(line) });
    ed.focus();
  }, script);
  await page.keyboard.type(trigger, { delay: 50 });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const w = document.querySelector(".suggest-widget");
    if (!w || w.classList.contains("hidden")) return [];
    return [...w.querySelectorAll(".monaco-list-row .label-name")].map((x) => x.textContent.trim());
  });
}

test("model uses the dedicated c3script language", async () => {
  const lang = await page.evaluate(() => window.monaco.editor.getModels()[0].getLanguageId());
  assert.equal(lang, "c3script");
});

test("`game.` lists only the host object's members", async () => {
  const rows = await suggestionsAfter("game", ".");
  assert.deepEqual(rows.sort(), ["objects", "on", "reset"]);
});

test("`game.objects.player.` lists the player's API", async () => {
  const rows = await suggestionsAfter("game.objects.player", ".");
  for (const m of ["hp", "setVelocity", "setPosition", "jumpStrength"]) {
    assert.ok(rows.includes(m), `expected player.${m}`);
  }
});

test("local alias: `let p = game.objects.player; p.` completes the player", async () => {
  const rows = await suggestionsAfter("let p = game.objects.player\np", ".");
  for (const m of ["hp", "setVelocity", "x", "y"]) {
    assert.ok(rows.includes(m), `expected p.${m}`);
  }
});

test("array literal: `let a = [1,2]; a.` completes array methods", async () => {
  const rows = await suggestionsAfter("let a = [1, 2]\na", ".");
  for (const m of ["push", "pop", "slice", "indexOf", "join"]) {
    assert.ok(rows.includes(m), `expected a.${m}`);
  }
});

test("instance: `let e = new Enemy(); e.` completes class members + ctor fields", async () => {
  const rows = await suggestionsAfter(
    "class Enemy { constructor() { this.hp = 1 } hurt(n) {} }\nlet e = new Enemy()\ne",
    ".",
  );
  assert.ok(rows.includes("hurt"), "method");
  assert.ok(rows.includes("hp"), "constructor field");
});

test('string argument: `game.on("` offers the event names', async () => {
  const rows = await suggestionsAfter("game.on(", '"');
  assert.deepEqual(rows.sort(), ["hurt", "input", "jump", "land", "tick"]);
});

test("a quote inside a comment does not break member completion", async () => {
  const rows = await suggestionsAfter('// type game.on(" for events\ngame', ".");
  assert.deepEqual(rows.sort(), ["objects", "on", "reset"]);
});
