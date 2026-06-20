// Bundle c3script into single-file drop-ins (no dependencies, no transpile —
// just bundling for plain-browser use). Run: `npm run build`. Outputs to dist/:
//
//   c3script.js          ESM, readable      -> import { Interpreter } from "./c3script.js"
//   c3script.min.js      ESM, minified      -> <script type="module">import {...}
//   c3script.global.js   IIFE, window.c3script (minified) -> classic <script src>
//
// The runtime has zero dependencies, so each file is fully self-contained.

import { build } from "esbuild";

const entry = { entryPoints: ["src/index.js"], bundle: true };
const banner = { js: "/* c3script — sandboxed JS-like scripting language (MIT) */" };

await Promise.all([
  build({ ...entry, format: "esm", outfile: "dist/c3script.js", banner }),
  build({ ...entry, format: "esm", minify: true, outfile: "dist/c3script.min.js", banner }),
  build({
    ...entry,
    format: "iife",
    globalName: "c3script",
    minify: true,
    outfile: "dist/c3script.global.js",
    banner,
  }),
]);

console.log("built dist/c3script.js, dist/c3script.min.js, dist/c3script.global.js");
