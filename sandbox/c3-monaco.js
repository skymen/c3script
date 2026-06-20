// Reusable Monaco glue for c3script. Drop-in:
//
//   const ed = new C3Editor(container, { monaco, globals, argEnums, source });
//   const program = ed.run();   // compiles + runs; logs errors to console
//
// Provides: JS-based syntax highlighting, live parse diagnostics (red squiggles),
// global-object autocomplete (reflected from `globals`), and contextual string
// argument completion (e.g. game.on("<suggestions>")). It has no build step and
// no dependency beyond the `monaco` instance you pass in.

import { Interpreter, LangError, parse } from "../src/index.js";
import {
  callContextAt, completionPath, describeObject, memberSuggestions,
  collectScriptSymbols, enumValuesFor, docFor, BUILTINS, KEYWORDS,
} from "../src/editor-support.js";

let providersRegistered = false;
const registry = new Map(); // model URI -> C3Editor instance

export class C3Editor {
  constructor(container, {
    monaco,
    globals = {},
    argEnums = {},
    docs = {},
    source = "",
    language = "c3script",
    theme = "vs-dark",
  } = {}) {
    if (!monaco) throw new Error("C3Editor requires a `monaco` instance");
    this.monaco = monaco;
    this.globals = globals;
    this.argEnums = argEnums;
    this.docs = docs;

    // c3script is its OWN Monaco language (not JavaScript), so the only completion/
    // hover provider in play is ours — no built-in JS IntelliSense competing with it.
    // Must register the language before a model is created with it.
    registerLanguage(monaco, language);

    this.editor = monaco.editor.create(container, {
      value: source,
      language,
      theme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 2,
      scrollBeyondLastLine: false,
      // No document-word suggestions — only our c3script completions.
      // (boolean form; Monaco 0.45 predates the "off"/"currentDocument" enum.)
      wordBasedSuggestions: false,
    });
    this.model = this.editor.getModel();
    registry.set(this.model.uri.toString(), this);

    this._lint();
    this.model.onDidChangeContent(() => this._lint());
  }

  getSource() {
    return this.editor.getValue();
  }

  // Compile + run with fresh state. Returns the Program, or null on error.
  run() {
    const vm = new Interpreter();
    vm.defineGlobals(this.globals);
    try {
      const program = vm.compile(this.getSource());
      program.run();
      return program;
    } catch (e) {
      console.error(e instanceof LangError ? "c3script: " + e.format() : e);
      return null;
    }
  }

  dispose() {
    registry.delete(this.model.uri.toString());
    this.editor.dispose();
  }

  // Map a c3script parse error to a Monaco marker.
  _lint() {
    const monaco = this.monaco;
    try {
      parse(this.model.getValue());
      monaco.editor.setModelMarkers(this.model, "c3", []);
    } catch (e) {
      const line = e && e.line ? e.line : 1;
      const col = e && e.column ? e.column : 1;
      monaco.editor.setModelMarkers(this.model, "c3", [{
        severity: monaco.MarkerSeverity.Error,
        message: (e && e.langMessage) || String(e),
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: col + 1,
      }]);
    }
  }
}

function registerLanguage(monaco, language) {
  if (providersRegistered) return;
  providersRegistered = true;

  // Register c3script as a first-class Monaco language: tokenizer (highlighting),
  // language configuration (comments/brackets/auto-close), and our providers.
  monaco.languages.register({ id: language });
  monaco.languages.setLanguageConfiguration(language, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider(language, {
    defaultToken: "",
    keywords: KEYWORDS,
    builtins: BUILTINS,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/[A-Za-z_$][\w$]*/, {
          cases: { "@keywords": "keyword", "@builtins": "predefined", "@default": "identifier" },
        }],
        [/\d+\.?\d*([eE][-+]?\d+)?/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
      ],
      comment: [
        [/[^*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: [".", '"', "'"],
    provideCompletionItems(model, position) {
      const inst = registry.get(model.uri.toString());
      if (!inst) return { suggestions: [] };

      const K = monaco.languages.CompletionItemKind;
      const snippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

      const prefix = model.getValueInRange({
        startLineNumber: 1, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };

      // 1. Contextual string-argument enum: game.on("<here>")
      const ctx = callContextAt(prefix);
      if (ctx && ctx.inString) {
        const values = enumValuesFor(ctx, { globals: inst.globals, argEnums: inst.argEnums });
        if (!values) return { suggestions: [] };
        return {
          suggestions: values.map((v) => ({
            label: v, kind: K.EnumMember, insertText: v, range,
          })),
        };
      }

      const withDoc = (item, doc) =>
        doc ? { ...item, documentation: { value: doc } } : item;

      const fnItem = (name, detail) => ({
        label: name, kind: K.Function, detail,
        insertText: name + "($0)", insertTextRules: snippetRule, range,
      });
      // `path` is the dotted receiver path, used to resolve docs (schema or
      // the receiver's __docs__ convention) for each member.
      const memberItem = (d, path) => withDoc({
        label: d.name,
        kind: d.kind === "function" ? K.Method : d.kind === "object" ? K.Module : K.Field,
        detail: d.kind === "function" && d.arity != null ? `function(${d.arity} args)` : d.kind,
        insertText: d.kind === "function" ? d.name + "($0)" : d.name,
        insertTextRules: d.kind === "function" ? snippetRule : undefined,
        range,
      }, docFor(inst.globals, inst.docs, path, d.name));

      // 2. Member completion after a dot. Resolves the root through inferred
      // local-variable types (e.g. `let p = game.objects.player; p.`) and the
      // live globals graph. Parse only the lines BEFORE the cursor: the line being
      // typed (`p.`) is incomplete and would otherwise break alias inference.
      const cp = completionPath(prefix);
      if (cp.isMember) {
        const source = inst.getSource().split("\n").slice(0, position.lineNumber - 1).join("\n");
        const members = memberSuggestions(cp.path, { globals: inst.globals, source });
        return { suggestions: members.map((d) => memberItem(d, cp.path)) };
      }

      // 3. Top-level: globals + builtins + the user's own declarations + keywords.
      // De-dupe by label so the four sources don't produce repeats.
      const out = [];
      const seen = new Set();
      const add = (item) => { if (!seen.has(item.label)) { seen.add(item.label); out.push(item); } };

      for (const d of describeObject(inst.globals)) add(memberItem(d, []));
      for (const name of BUILTINS) add(fnItem(name, "builtin"));
      for (const s of collectScriptSymbols(inst.getSource())) {
        add({
          label: s.name,
          kind: s.kind === "function" ? K.Function : s.kind === "class" ? K.Class : K.Variable,
          detail: s.kind, insertText: s.name, range,
        });
      }
      for (const kw of KEYWORDS) {
        add({ label: kw, kind: K.Keyword, detail: "keyword", insertText: kw, range });
      }
      return { suggestions: out };
    },
  });

  // Hover: show a prop's doc (from the `docs` schema or a `__docs__` convention).
  monaco.languages.registerHoverProvider(language, {
    provideHover(model, position) {
      const inst = registry.get(model.uri.toString());
      if (!inst) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // The dotted path ending at the hovered word (e.g. game.objects.player.hp).
      const lineToWord = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: word.endColumn,
      });
      const m = lineToWord.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
      if (!m) return null;
      const parts = m[0].split(".");
      const name = parts.pop();
      const doc = docFor(inst.globals, inst.docs, parts, name);
      if (!doc) return null;
      return {
        range: new monaco.Range(
          position.lineNumber, word.startColumn, position.lineNumber, word.endColumn,
        ),
        contents: [{ value: doc }],
      };
    },
  });
}
