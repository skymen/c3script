// Lexer: turns a source string into a flat array of tokens, each tagged with
// its line and column for error reporting. Ends with a single EOF token.

import { LangError } from "./errors.js";

const KEYWORDS = new Set([
  "let", "const", "function", "return", "if", "else", "while", "for",
  "break", "continue", "true", "false", "null", "class", "new", "this",
  "extends", "super",
]);

export const T = {
  NUMBER: "NUMBER",
  STRING: "STRING",
  IDENT: "IDENT",
  KEYWORD: "KEYWORD",
  PUNCT: "PUNCT",
  EOF: "EOF",
};

// Multi-char operators, matched before single-char punctuation.
const OPS2 = ["==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "=>"];
const SINGLES = "(){}[],;.+-*/%=<>!?:";

const isDigit = (c) => c >= "0" && c <= "9";
const isIdentStart = (c) => !!c && /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => !!c && /[A-Za-z0-9_$]/.test(c);

export function tokenize(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const peek = (o = 0) => source[i + o];
  const advance = () => {
    const c = source[i++];
    if (c === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return c;
  };

  while (i < n) {
    const startLine = line;
    const startCol = col;
    const c = peek();

    // Whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    // Line comment
    if (c === "/" && peek(1) === "/") {
      while (i < n && peek() !== "\n") advance();
      continue;
    }

    // Block comment
    if (c === "/" && peek(1) === "*") {
      advance();
      advance();
      while (i < n && !(peek() === "*" && peek(1) === "/")) advance();
      if (i >= n) {
        throw new LangError("unterminated block comment", {
          line: startLine, column: startCol, phase: "lex",
        });
      }
      advance();
      advance();
      continue;
    }

    // Number (integer, decimal, exponent)
    if (isDigit(c) || (c === "." && isDigit(peek(1)))) {
      let s = "";
      while (isDigit(peek())) s += advance();
      if (peek() === ".") {
        s += advance();
        while (isDigit(peek())) s += advance();
      }
      if (peek() === "e" || peek() === "E") {
        s += advance();
        if (peek() === "+" || peek() === "-") s += advance();
        while (isDigit(peek())) s += advance();
      }
      tokens.push({ type: T.NUMBER, value: parseFloat(s), line: startLine, column: startCol });
      continue;
    }

    // String (single or double quoted, with escapes)
    if (c === '"' || c === "'") {
      const quote = advance();
      let s = "";
      while (i < n && peek() !== quote) {
        const ch = advance();
        if (ch === "\n") {
          throw new LangError("unterminated string", {
            line: startLine, column: startCol, phase: "lex",
          });
        }
        if (ch === "\\") {
          const e = advance();
          switch (e) {
            case "n": s += "\n"; break;
            case "t": s += "\t"; break;
            case "r": s += "\r"; break;
            case "\\": s += "\\"; break;
            case '"': s += '"'; break;
            case "'": s += "'"; break;
            case "0": s += "\0"; break;
            default: s += e;
          }
        } else {
          s += ch;
        }
      }
      if (i >= n) {
        throw new LangError("unterminated string", {
          line: startLine, column: startCol, phase: "lex",
        });
      }
      advance(); // consume closing quote
      tokens.push({ type: T.STRING, value: s, line: startLine, column: startCol });
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      let s = "";
      while (isIdentPart(peek())) s += advance();
      tokens.push({
        type: KEYWORDS.has(s) ? T.KEYWORD : T.IDENT,
        value: s,
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Two-char operators
    const two = source.slice(i, i + 2);
    if (OPS2.includes(two)) {
      advance();
      advance();
      tokens.push({ type: T.PUNCT, value: two, line: startLine, column: startCol });
      continue;
    }

    // Single-char punctuation
    if (SINGLES.includes(c)) {
      advance();
      tokens.push({ type: T.PUNCT, value: c, line: startLine, column: startCol });
      continue;
    }

    throw new LangError(`unexpected character '${c}'`, {
      line: startLine, column: startCol, phase: "lex",
    });
  }

  tokens.push({ type: T.EOF, value: null, line, column: col });
  return tokens;
}
