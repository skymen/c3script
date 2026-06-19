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
  callContextAt, completionPath, resolvePathValue, describeObject,
  collectScriptSymbols, enumValuesFor, BUILTINS,
} from "../src/editor-support.js";

let providersRegistered = false;
const registry = new Map(); // model URI -> C3Editor instance

export class C3Editor {
  constructor(container, {
    monaco,
    globals = {},
    argEnums = {},
    source = "",
    language = "javascript",
    theme = "vs-dark",
  } = {}) {
    if (!monaco) throw new Error("C3Editor requires a `monaco` instance");
    this.monaco = monaco;
    this.globals = globals;
    this.argEnums = argEnums;

    // Highlight with JS, but turn off JS/TS validation — we provide our own.
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });

    this.editor = monaco.editor.create(container, {
      value: source,
      language,
      theme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 2,
      scrollBeyondLastLine: false,
    });
    this.model = this.editor.getModel();
    registry.set(this.model.uri.toString(), this);

    registerProviders(monaco, language);
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

function registerProviders(monaco, language) {
  if (providersRegistered) return;
  providersRegistered = true;

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

      const fnItem = (name, detail) => ({
        label: name, kind: K.Function, detail,
        insertText: name + "($0)", insertTextRules: snippetRule, range,
      });
      const memberItem = (d) => ({
        label: d.name,
        kind: d.kind === "function" ? K.Method : d.kind === "object" ? K.Module : K.Field,
        detail: d.kind === "function" && d.arity != null ? `function(${d.arity} args)` : d.kind,
        insertText: d.kind === "function" ? d.name + "($0)" : d.name,
        insertTextRules: d.kind === "function" ? snippetRule : undefined,
        range,
      });

      // 2. Member completion after a dot (reflected from the live globals).
      const cp = completionPath(prefix);
      if (cp.isMember) {
        const obj = resolvePathValue(inst.globals, cp.path);
        return { suggestions: describeObject(obj).map(memberItem) };
      }

      // 3. Top-level: globals + builtins + the user's own declarations.
      const out = describeObject(inst.globals).map(memberItem);
      for (const name of BUILTINS) out.push(fnItem(name, "builtin"));
      for (const s of collectScriptSymbols(inst.getSource())) {
        out.push({
          label: s.name,
          kind: s.kind === "function" ? K.Function : s.kind === "class" ? K.Class : K.Variable,
          detail: s.kind, insertText: s.name, range,
        });
      }
      return { suggestions: out };
    },
  });
}
