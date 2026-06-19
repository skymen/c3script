// Unified error type for every phase of the language: lexing, parsing, runtime.
// Carries source position (line/column) and, for runtime errors, a rendered
// script-level call stack so users get debuggable messages.

export class LangError extends Error {
  constructor(message, { line = null, column = null, phase = "runtime", stack = null } = {}) {
    super(message);
    this.name = "LangError";
    this.langMessage = message;
    this.line = line;
    this.column = column;
    this.phase = phase; // "lex" | "parse" | "runtime"
    this.scriptStack = stack; // optional array of { name, line }
  }

  format() {
    const loc =
      this.line != null
        ? ` at line ${this.line}${this.column != null ? `:${this.column}` : ""}`
        : "";
    let out = `${this.phase} error${loc}: ${this.langMessage}`;
    if (this.scriptStack && this.scriptStack.length) {
      out +=
        "\n" +
        this.scriptStack
          .map((f) => `  at ${f.name}${f.line != null ? ` (line ${f.line})` : ""}`)
          .join("\n");
    }
    return out;
  }
}
