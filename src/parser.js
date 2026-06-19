// Parser: tokens -> AST. Recursive descent for statements, precedence-climbing
// (Pratt-style) for expressions. Semicolons are optional.

import { tokenize, T } from "./lexer.js";
import { node } from "./ast.js";
import { LangError } from "./errors.js";

// Binary operator precedence (higher binds tighter). Logical ops included.
const BINARY_PREC = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4, "instanceof": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);

function describe(tok) {
  if (tok.type === T.EOF) return "end of input";
  if (tok.type === T.STRING) return `string ${JSON.stringify(tok.value)}`;
  return `'${tok.value}'`;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(o = 0) {
    return this.tokens[this.pos + o];
  }
  next() {
    return this.tokens[this.pos++];
  }
  is(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  isPunct(v) {
    return this.is(T.PUNCT, v);
  }
  isKw(v) {
    return this.is(T.KEYWORD, v);
  }
  error(msg) {
    const t = this.peek();
    throw new LangError(`${msg} but got ${describe(t)}`, {
      line: t.line, column: t.column, phase: "parse",
    });
  }
  expectPunct(v) {
    if (!this.isPunct(v)) this.error(`expected '${v}'`);
    return this.next();
  }
  expectIdent() {
    if (!this.is(T.IDENT)) this.error("expected an identifier");
    return this.next();
  }
  // Consume an optional statement-terminating semicolon.
  semi() {
    if (this.isPunct(";")) this.next();
  }

  // ---- Program / statements ----

  parseProgram() {
    const body = [];
    while (!this.is(T.EOF)) body.push(this.parseStatement());
    return node("Program", { body, line: 1 });
  }

  parseStatement() {
    if (this.isKw("let") || this.isKw("const")) return this.parseVarDecl();
    if (this.isKw("function")) return this.parseFunctionDecl();
    if (this.isKw("class")) return this.parseClassDecl();
    if (this.isKw("if")) return this.parseIf();
    if (this.isKw("while")) return this.parseWhile();
    if (this.isKw("for")) return this.parseFor();
    if (this.isKw("return")) return this.parseReturn();
    if (this.isKw("break")) {
      const line = this.next().line;
      this.semi();
      return node("BreakStmt", { line });
    }
    if (this.isKw("continue")) {
      const line = this.next().line;
      this.semi();
      return node("ContinueStmt", { line });
    }
    if (this.isPunct("{")) return this.parseBlock();
    const line = this.peek().line;
    const expression = this.parseExpression();
    this.semi();
    return node("ExprStmt", { expression, line });
  }

  parseVarDecl() {
    const kw = this.next();
    const name = this.expectIdent().value;
    let init = null;
    if (this.isPunct("=")) {
      this.next();
      init = this.parseAssignment();
    } else if (kw.value === "const") {
      this.error("const declaration requires an initializer");
    }
    this.semi();
    return node("VarDecl", { kind: kw.value, name, init, line: kw.line });
  }

  parseFunctionDecl() {
    const line = this.next().line; // 'function'
    const name = this.expectIdent().value;
    const params = this.parseParams();
    const body = this.parseBlock();
    return node("FunctionDecl", { name, params, body, line });
  }

  parseClassDecl() {
    const line = this.next().line; // 'class'
    const name = this.expectIdent().value;
    let superClass = null;
    if (this.isKw("extends")) {
      this.next();
      superClass = this.parseCallMember(); // identifier or dotted path
    }
    this.expectPunct("{");
    const members = [];
    while (!this.isPunct("}") && !this.is(T.EOF)) {
      const mLine = this.peek().line;
      const mName = this.expectIdent().value;
      const params = this.parseParams();
      const mBody = this.parseBlock();
      members.push({
        name: mName,
        params,
        body: mBody,
        isCtor: mName === "constructor",
        line: mLine,
      });
    }
    this.expectPunct("}");
    return node("ClassDecl", { name, superClass, members, line });
  }

  parseIf() {
    const line = this.next().line;
    this.expectPunct("(");
    const test = this.parseExpression();
    this.expectPunct(")");
    const consequent = this.parseStatement();
    let alternate = null;
    if (this.isKw("else")) {
      this.next();
      alternate = this.parseStatement();
    }
    return node("IfStmt", { test, consequent, alternate, line });
  }

  parseWhile() {
    const line = this.next().line;
    this.expectPunct("(");
    const test = this.parseExpression();
    this.expectPunct(")");
    const body = this.parseStatement();
    return node("WhileStmt", { test, body, line });
  }

  parseFor() {
    const line = this.next().line;
    this.expectPunct("(");

    let init = null;
    if (this.isPunct(";")) {
      this.next();
    } else if (this.isKw("let") || this.isKw("const")) {
      const kind = this.next().value;
      const name = this.expectIdent().value;
      if (this.is(T.IDENT, "of")) {
        this.next(); // 'of'
        const iterable = this.parseAssignment();
        this.expectPunct(")");
        const body = this.parseStatement();
        return node("ForOfStmt", { kind, name, iterable, body, line });
      }
      let vinit = null;
      if (this.isPunct("=")) {
        this.next();
        vinit = this.parseAssignment();
      }
      init = node("VarDecl", { kind, name, init: vinit, line });
      this.expectPunct(";");
    } else {
      const e = this.parseExpression();
      init = node("ExprStmt", { expression: e, line });
      this.expectPunct(";");
    }

    const test = this.isPunct(";") ? null : this.parseExpression();
    this.expectPunct(";");
    const update = this.isPunct(")") ? null : this.parseExpression();
    this.expectPunct(")");
    const body = this.parseStatement();
    return node("ForStmt", { init, test, update, body, line });
  }

  parseReturn() {
    const line = this.next().line;
    let argument = null;
    if (!this.isPunct(";") && !this.isPunct("}") && !this.is(T.EOF)) {
      argument = this.parseExpression();
    }
    this.semi();
    return node("ReturnStmt", { argument, line });
  }

  parseBlock() {
    const line = this.peek().line;
    this.expectPunct("{");
    const body = [];
    while (!this.isPunct("}") && !this.is(T.EOF)) body.push(this.parseStatement());
    this.expectPunct("}");
    return node("BlockStmt", { body, line });
  }

  parseParams() {
    this.expectPunct("(");
    const params = [];
    if (!this.isPunct(")")) {
      params.push(this.expectIdent().value);
      while (this.isPunct(",")) {
        this.next();
        params.push(this.expectIdent().value);
      }
    }
    this.expectPunct(")");
    return params;
  }

  // ---- Expressions ----

  parseExpression() {
    return this.parseAssignment();
  }

  parseAssignment() {
    const left = this.parseTernary();
    if (this.is(T.PUNCT) && ASSIGN_OPS.has(this.peek().value)) {
      const opTok = this.next();
      if (!["Identifier", "Member", "Index"].includes(left.type)) {
        throw new LangError("invalid assignment target", {
          line: opTok.line, column: opTok.column, phase: "parse",
        });
      }
      const value = this.parseAssignment(); // right-associative
      return node("Assign", { target: left, op: opTok.value, value, line: opTok.line });
    }
    return left;
  }

  parseTernary() {
    const test = this.parseBinary(1);
    if (this.isPunct("?")) {
      const line = this.next().line;
      const consequent = this.parseAssignment();
      this.expectPunct(":");
      const alternate = this.parseAssignment();
      return node("Ternary", { test, consequent, alternate, line });
    }
    return test;
  }

  parseBinary(minPrec) {
    let left = this.parseUnary();
    // `instanceof` is a keyword operator; every other binary op is punctuation.
    while (this.is(T.PUNCT) || this.isKw("instanceof")) {
      const t = this.peek();
      const prec = BINARY_PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1); // left-associative
      const kind = t.value === "&&" || t.value === "||" ? "Logical" : "Binary";
      left = node(kind, { op: t.value, left, right, line: t.line });
    }
    return left;
  }

  parseUnary() {
    if (this.isKw("await")) {
      const t = this.next();
      const argument = this.parseUnary();
      return node("Await", { argument, line: t.line });
    }
    if (this.isKw("typeof")) {
      const t = this.next();
      const argument = this.parseUnary();
      return node("Unary", { op: "typeof", argument, line: t.line });
    }
    if (this.isPunct("++") || this.isPunct("--")) {
      const op = this.next();
      const argument = this.parseUnary();
      this.checkUpdateTarget(argument, op);
      return node("Update", { op: op.value, prefix: true, argument, line: op.line });
    }
    if (this.isPunct("!") || this.isPunct("-")) {
      const op = this.next();
      const argument = this.parseUnary();
      return node("Unary", { op: op.value, argument, line: op.line });
    }
    return this.parsePostfix();
  }

  // A call/member expression optionally followed by a single postfix ++ / --.
  parsePostfix() {
    let expr = this.parseCallMember();
    if (this.isPunct("++") || this.isPunct("--")) {
      const op = this.next();
      this.checkUpdateTarget(expr, op);
      expr = node("Update", { op: op.value, prefix: false, argument: expr, line: op.line });
    }
    return expr;
  }

  // ++ / -- require an assignable target (variable, member, or index).
  checkUpdateTarget(target, opTok) {
    if (!["Identifier", "Member", "Index"].includes(target.type)) {
      throw new LangError(`'${opTok.value}' requires a variable, property, or index`, {
        line: opTok.line, column: opTok.column, phase: "parse",
      });
    }
  }

  parseCallMember() {
    let expr = this.parsePrimary();
    while (true) {
      if (this.isPunct("(")) {
        expr = this.finishCall(expr);
      } else if (this.isPunct(".")) {
        const line = this.next().line;
        const property = this.expectIdent().value;
        expr = node("Member", { object: expr, property, line });
      } else if (this.isPunct("[")) {
        const line = this.next().line;
        const index = this.parseExpression();
        this.expectPunct("]");
        expr = node("Index", { object: expr, index, line });
      } else {
        break;
      }
    }
    return expr;
  }

  finishCall(callee) {
    const line = this.peek().line;
    this.expectPunct("(");
    const args = [];
    if (!this.isPunct(")")) {
      args.push(this.parseAssignment());
      while (this.isPunct(",")) {
        this.next();
        args.push(this.parseAssignment());
      }
    }
    this.expectPunct(")");
    return node("Call", { callee, args, line });
  }

  parsePrimary() {
    const t = this.peek();

    if (t.type === T.NUMBER) {
      this.next();
      return node("NumberLit", { value: t.value, line: t.line });
    }
    if (t.type === T.STRING) {
      this.next();
      return node("StringLit", { value: t.value, line: t.line });
    }
    if (t.type === T.KEYWORD) {
      switch (t.value) {
        case "true":
        case "false":
          this.next();
          return node("BoolLit", { value: t.value === "true", line: t.line });
        case "null":
          this.next();
          return node("NullLit", { line: t.line });
        case "this":
          this.next();
          return node("ThisExpr", { line: t.line });
        case "super":
          this.next();
          return node("SuperExpr", { line: t.line });
        case "function":
          return this.parseFunctionExpr();
        case "new":
          return this.parseNew();
        default:
          this.error(`unexpected keyword '${t.value}'`);
      }
    }
    if (t.type === T.IDENT) {
      // Single-parameter arrow: x => ...
      const nxt = this.peek(1);
      if (nxt && nxt.type === T.PUNCT && nxt.value === "=>") {
        this.next(); // param
        return this.finishArrow([t.value], t.line);
      }
      this.next();
      return node("Identifier", { name: t.value, line: t.line });
    }
    if (this.isPunct("(")) {
      if (this.isArrowParenAhead()) {
        const params = this.parseParams();
        return this.finishArrow(params, t.line);
      }
      this.next();
      const e = this.parseExpression();
      this.expectPunct(")");
      return e;
    }
    if (this.isPunct("[")) return this.parseArrayLit();
    if (this.isPunct("{")) return this.parseObjectLit();

    this.error("unexpected token");
  }

  // Lookahead: at "(", scan to the matching ")" and check for a following "=>".
  isArrowParenAhead() {
    let depth = 0;
    let p = this.pos;
    while (p < this.tokens.length) {
      const t = this.tokens[p];
      if (t.type === T.EOF) return false;
      if (t.type === T.PUNCT && t.value === "(") depth++;
      else if (t.type === T.PUNCT && t.value === ")") {
        depth--;
        if (depth === 0) {
          const after = this.tokens[p + 1];
          return !!after && after.type === T.PUNCT && after.value === "=>";
        }
      }
      p++;
    }
    return false;
  }

  finishArrow(params, line) {
    this.expectPunct("=>");
    let body;
    if (this.isPunct("{")) {
      body = this.parseBlock();
    } else {
      // Expression body -> implicit return.
      const expr = this.parseAssignment();
      body = node("BlockStmt", {
        body: [node("ReturnStmt", { argument: expr, line })],
        line,
      });
    }
    return node("FunctionExpr", { params, body, name: null, line });
  }

  parseFunctionExpr() {
    const line = this.next().line; // 'function'
    let name = null;
    if (this.is(T.IDENT)) name = this.next().value;
    const params = this.parseParams();
    const body = this.parseBlock();
    return node("FunctionExpr", { params, body, name, line });
  }

  parseNew() {
    const line = this.next().line; // 'new'
    let callee = this.parsePrimary();
    while (this.isPunct(".")) {
      this.next();
      const property = this.expectIdent().value;
      callee = node("Member", { object: callee, property, line });
    }
    const args = [];
    if (this.isPunct("(")) {
      this.expectPunct("(");
      if (!this.isPunct(")")) {
        args.push(this.parseAssignment());
        while (this.isPunct(",")) {
          this.next();
          args.push(this.parseAssignment());
        }
      }
      this.expectPunct(")");
    }
    return node("NewExpr", { callee, args, line });
  }

  parseArrayLit() {
    const line = this.next().line; // '['
    const elements = [];
    while (!this.isPunct("]") && !this.is(T.EOF)) {
      elements.push(this.parseAssignment());
      if (this.isPunct(",")) this.next();
      else break;
    }
    this.expectPunct("]");
    return node("ArrayLit", { elements, line });
  }

  parseObjectLit() {
    const line = this.next().line; // '{'
    const properties = [];
    while (!this.isPunct("}") && !this.is(T.EOF)) {
      const kt = this.peek();
      let key;
      if (kt.type === T.IDENT || kt.type === T.KEYWORD) key = this.next().value;
      else if (kt.type === T.STRING) key = this.next().value;
      else if (kt.type === T.NUMBER) key = String(this.next().value);
      else this.error("expected a property name");
      this.expectPunct(":");
      const value = this.parseAssignment();
      properties.push({ key, value });
      if (this.isPunct(",")) this.next();
      else break;
    }
    this.expectPunct("}");
    return node("ObjectLit", { properties, line });
  }
}

export function parse(source) {
  const tokens = tokenize(source);
  try {
    return new Parser(tokens).parseProgram();
  } catch (e) {
    // Pathologically nested input overflows recursive descent — report cleanly.
    if (e instanceof RangeError) {
      throw new LangError("input nests too deeply", { phase: "parse" });
    }
    throw e;
  }
}
