// AST node factory. Nodes are plain objects with a `type` tag plus a `line`
// for error reporting. This file centralizes the node-type vocabulary so the
// parser and interpreter agree on shapes.

export function node(type, props = {}) {
  return { type, ...props };
}

export const NODE_TYPES = Object.freeze([
  // Statements
  "Program", "VarDecl", "FunctionDecl", "ClassDecl", "ReturnStmt", "IfStmt",
  "WhileStmt", "ForStmt", "ForOfStmt", "BreakStmt", "ContinueStmt",
  "BlockStmt", "ExprStmt",
  // Expressions
  "NumberLit", "StringLit", "BoolLit", "NullLit", "Identifier", "ThisExpr",
  "ArrayLit", "ObjectLit", "FunctionExpr", "Assign", "Binary", "Logical",
  "Unary", "Ternary", "Call", "NewExpr", "Member", "Index", "SuperExpr",
]);
