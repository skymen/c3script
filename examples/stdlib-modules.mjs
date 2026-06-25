// Reference example: how a host implements a *namespaced module* for c3script.
//
// The language core ships only the bare verbs (print, log, len, range, …); it has
// no `Math`. Anything namespaced — `Math.floor(...)`, `Easing.outQuad(...)` — is a
// plain JS object the host registers. This file is that object for `Math`, plus a
// tiny `Easing` module, so you can copy the shape into your own project.
//
// Install it read-only (so scripts can't clobber `Math.floor`):
//
//   import { Interpreter } from "../src/index.js";
//   import { MathModule, Easing } from "./stdlib-modules.mjs";
//   const vm = new Interpreter({ modules: { Math: MathModule, Easing } });
//   await vm.run("log(Math.clamp(50, 0, 10))");   // -> 10
//
// For editor autocomplete/hover, also put the same objects in the `globals` map
// you hand your editor front-end — every member's doc comes from the sibling
// `__docs__` map (a `__`-prefixed key, so it's invisible to running scripts).

export const MathModule = {
  PI: Math.PI,
  E: Math.E,
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
  sign: (x) => Math.sign(x),
  sqrt: (x) => Math.sqrt(x),
  pow: (a, b) => Math.pow(a, b),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  atan2: (y, x) => Math.atan2(y, x),
  hypot: (...a) => Math.hypot(...a),
  random: () => Math.random(),
  randomRange: (lo, hi) => lo + Math.random() * (hi - lo),
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  lerp: (a, b, t) => a + (b - a) * t,
  rad: (deg) => (deg * Math.PI) / 180,
  deg: (rad) => (rad * 180) / Math.PI,
  __docs__: {
    PI: "Math.PI — ratio of a circle's circumference to its diameter (~3.14159).",
    E: "Math.E — Euler's number (~2.71828).",
    abs: "Math.abs(x) — absolute value of x.",
    floor: "Math.floor(x) — largest integer <= x.",
    ceil: "Math.ceil(x) — smallest integer >= x.",
    round: "Math.round(x) — x rounded to the nearest integer.",
    sign: "Math.sign(x) — -1, 0, or 1 matching the sign of x.",
    sqrt: "Math.sqrt(x) — square root of x.",
    pow: "Math.pow(a, b) — a raised to the power b.",
    min: "Math.min(...values) — the smallest of the given numbers.",
    max: "Math.max(...values) — the largest of the given numbers.",
    sin: "Math.sin(radians) — sine of an angle in radians.",
    cos: "Math.cos(radians) — cosine of an angle in radians.",
    tan: "Math.tan(radians) — tangent of an angle in radians.",
    atan2: "Math.atan2(y, x) — angle (radians) of the vector (x, y).",
    hypot: "Math.hypot(...values) — sqrt of the sum of squares (vector length).",
    random: "Math.random() — a random number in [0, 1).",
    randomRange: "Math.randomRange(lo, hi) — a random number in [lo, hi).",
    clamp: "Math.clamp(x, lo, hi) — constrain x to the range [lo, hi].",
    lerp: "Math.lerp(a, b, t) — linear interpolation from a to b; t in [0, 1].",
    rad: "Math.rad(degrees) — convert degrees to radians.",
    deg: "Math.deg(radians) — convert radians to degrees.",
  },
};

export const Easing = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  __docs__: {
    linear: "Easing.linear(t) — no easing; returns t unchanged.",
    inQuad: "Easing.inQuad(t) — quadratic ease-in.",
    outQuad: "Easing.outQuad(t) — quadratic ease-out.",
    inOutQuad: "Easing.inOutQuad(t) — quadratic ease-in-out.",
  },
};

// Convenience: the aggregate you can hand straight to `new Interpreter({ modules })`.
export const STDLIB_MODULES = { Math: MathModule, Easing };
