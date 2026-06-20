import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionPath, resolvePathValue, describeObject, docFor,
  collectScriptSymbols, openStringStart, callContextAt,
  inferLocalTypes, classMembers, memberSuggestions, ARRAY_MEMBERS, STRING_MEMBERS,
  BUILTINS, KEYWORDS,
} from "../src/editor-support.js";

test("BUILTINS is in sync with the stdlib (no removed `type`, includes sleep/all)", () => {
  assert.ok(!BUILTINS.includes("type"), "`type` was removed from the language");
  assert.ok(BUILTINS.includes("sleep"));
  assert.ok(BUILTINS.includes("all"));
  assert.ok(BUILTINS.includes("print"));
});

test("KEYWORDS covers the language keywords used for completion", () => {
  for (const kw of ["let", "for", "class", "await", "typeof", "instanceof"]) {
    assert.ok(KEYWORDS.includes(kw), `missing keyword ${kw}`);
  }
});

test("completionPath splits a dotted prefix into path + partial", () => {
  assert.deepEqual(completionPath("game.objects.pl"), {
    path: ["game", "objects"], partial: "pl", isMember: true,
  });
  assert.deepEqual(completionPath("game."), { path: ["game"], partial: "", isMember: true });
  assert.deepEqual(completionPath("ga"), { path: [], partial: "ga", isMember: false });
  assert.deepEqual(completionPath("let x = a.b."), { path: ["a", "b"], partial: "", isMember: true });
});

test("resolvePathValue walks the object graph", () => {
  const root = { game: { objects: { player: { hp: 100 } } } };
  assert.equal(resolvePathValue(root, ["game", "objects", "player"]).hp, 100);
  assert.equal(resolvePathValue(root, []), root);
  assert.equal(resolvePathValue(root, ["game", "nope", "x"]), undefined);
});

test("describeObject lists own non-__ members with kinds and docs", () => {
  const game = {
    __events__: ["a"],
    __docs__: { spawn: "Spawn an object" },
    spawn: (t, x, y) => {},
    objects: {},
    title: "lvl1",
  };
  const members = describeObject(game);
  const names = members.map((m) => m.name).sort();
  assert.deepEqual(names, ["objects", "spawn", "title"]); // __events__/__docs__ hidden

  const spawn = members.find((m) => m.name === "spawn");
  assert.equal(spawn.kind, "function");
  assert.equal(spawn.arity, 3);
  assert.equal(spawn.doc, "Spawn an object");

  const objects = members.find((m) => m.name === "objects");
  assert.equal(objects.kind, "object");
  assert.equal(objects.doc, undefined); // no __docs__ entry

  assert.deepEqual(describeObject(null), []);
});

test("docFor prefers the schema, then the __docs__ convention", () => {
  const root = { game: { __docs__: { spawn: "from convention" }, spawn: () => {} } };
  const schema = { "game.spawn": "from schema" };

  assert.equal(docFor(root, schema, ["game"], "spawn"), "from schema");
  assert.equal(docFor(root, {}, ["game"], "spawn"), "from convention");
  assert.equal(docFor(root, {}, ["game"], "missing"), undefined);
  // top-level (path []) reads root.__docs__ / a bare-name schema key
  assert.equal(docFor({ __docs__: { log: "logs" } }, {}, [], "log"), "logs");
  assert.equal(docFor({}, { print: "prints" }, [], "print"), "prints");
});

test("openStringStart detects only a genuinely open string", () => {
  assert.equal(openStringStart("game.on("), -1);          // no string
  assert.equal(openStringStart('f("a") + g'), -1);         // string closed
  assert.equal(openStringStart('f("ab') , 2);              // open string starts at the quote
  assert.equal(openStringStart("x = 'hi'"), -1);           // single quotes, closed
  // A quote inside a comment must NOT flip parity (the platformer-sample bug).
  assert.equal(openStringStart('// game.on(" for events\ngame.'), -1);
  assert.equal(openStringStart('/* " */ "open'), 8);       // block comment skipped
});

test("callContextAt is null outside a string, even after comment quotes", () => {
  // The exact shape that broke member completion: a comment containing a quote,
  // then a real string, then a bare `obj.` — must NOT read as in-string.
  assert.equal(callContextAt('// type game.on(" here\nlet p=game.objects.player\ngame.'), null);
  assert.equal(callContextAt("a.b.c"), null);
});

test("callContextAt reports the call + arg index when inside a string", () => {
  const ctx = callContextAt('// game.on(" comment\ngame.on("');
  assert.equal(ctx.callee, "game.on");
  assert.equal(ctx.argIndex, 0);
  assert.equal(ctx.inString, true);
  // Argument index counts top-level commas: second string arg -> argIndex 1.
  assert.equal(callContextAt('spawn("Orc", "').argIndex, 1);
});

test("collectScriptSymbols gathers top-level declarations", () => {
  const syms = collectScriptSymbols("let a = 1\nconst b = 2\nfunction f() {}\nclass C {}");
  assert.deepEqual(syms, [
    { name: "a", kind: "variable" },
    { name: "b", kind: "variable" },
    { name: "f", kind: "function" },
    { name: "C", kind: "class" },
  ]);
  assert.deepEqual(collectScriptSymbols("let ="), []); // parse error -> []
});

test("inferLocalTypes maps top-level vars to type descriptors", () => {
  const t = inferLocalTypes([
    "let p = game.objects.player",
    "let q = p",                    // alias of an alias
    "let r = p.inventory",          // member off an alias
    "let a = [1, 2]",
    "let s = \"hi\"",
    "let e = new Enemy()",
    "let n = 5",                    // number -> not inferable, omitted
  ].join("\n"));

  assert.deepEqual(t.p, { kind: "globalPath", path: ["game", "objects", "player"] });
  assert.deepEqual(t.q, { kind: "globalPath", path: ["game", "objects", "player"] });
  assert.deepEqual(t.r, { kind: "globalPath", path: ["game", "objects", "player", "inventory"] });
  assert.deepEqual(t.a, { kind: "array" });
  assert.deepEqual(t.s, { kind: "string" });
  assert.deepEqual(t.e, { kind: "instance", className: "Enemy" });
  assert.equal(t.n, undefined);
  assert.deepEqual(inferLocalTypes("let ="), {}); // parse error -> {}
});

test("classMembers lists methods + ctor fields, walking extends", () => {
  const src = [
    "class Animal { constructor() { this.hp = 10 } breathe() {} }",
    "class Dog extends Animal { constructor() { super(); this.name = \"rex\" } bark(loud) {} }",
  ].join("\n");
  const names = classMembers(src, "Dog").map((m) => m.name).sort();
  assert.deepEqual(names, ["bark", "breathe", "hp", "name"]);
  const bark = classMembers(src, "Dog").find((m) => m.name === "bark");
  assert.deepEqual({ kind: bark.kind, arity: bark.arity }, { kind: "function", arity: 1 });
});

test("memberSuggestions resolves locals, then falls back to globals", () => {
  const player = { hp: 100, setVelocity: () => {}, __docs__: { hp: "health" } };
  const globals = { game: { on: () => {}, objects: { player } } };

  // alias -> the real object's members (with convention docs)
  const viaAlias = memberSuggestions(["p"], { globals, source: "let p = game.objects.player" });
  const hp = viaAlias.find((m) => m.name === "hp");
  assert.equal(hp.doc, "health");
  assert.ok(viaAlias.some((m) => m.name === "setVelocity"));

  // array / string literal -> built-in member lists
  assert.equal(memberSuggestions(["a"], { source: "let a = [1,2]" }), ARRAY_MEMBERS);
  assert.equal(memberSuggestions(["s"], { source: "let s = 'x'" }), STRING_MEMBERS);

  // instance -> class members
  const inst = memberSuggestions(["e"], { source: "class Enemy { hurt(n) {} }\nlet e = new Enemy()" });
  assert.deepEqual(inst.map((m) => m.name), ["hurt"]);

  // unknown root -> treated as a global (existing reflective behavior)
  const viaGlobal = memberSuggestions(["game"], { globals, source: "" });
  assert.deepEqual(viaGlobal.map((m) => m.name).sort(), ["objects", "on"]);
});
