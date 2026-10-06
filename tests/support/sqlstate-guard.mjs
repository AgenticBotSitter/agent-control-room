import ts from "typescript";
import { isSqlStateCodeV1 } from "../../src/persistence/node-errno-sqlstate.mjs";

// The same accept test the production reader uses, from the same frozen set, so
// this guard cannot decide "this string is not a SQLSTATE" differently from the
// reader it polices. A separate rule here would make every real server code the
// reader accepts look like a raw comparison to it.
const sqlState = value => isSqlStateCodeV1(value);
const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
  || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;

/** Syntax audit, not text matching: comments and strings containing code do not count. */
export function sqlStateCodeComparisons(source, file = "source.ts") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const initializers = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      initializers.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function readsCode(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "code") return true;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === "code") return true;
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "Reflect.get"
      && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === "code") return true;
    if (ts.isIdentifier(node) && !seen.has(node.text) && initializers.has(node.text)) {
      seen.add(node.text); return readsCode(initializers.get(node.text), seen);
    }
    if (ts.isConditionalExpression(node)) return readsCode(node.whenTrue, seen) || readsCode(node.whenFalse, seen);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind))
      return readsCode(node.left, seen) || readsCode(node.right, seen);
    return false;
  }
  function states(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isStringLiteralLike(node)) return sqlState(node.text);
    if (ts.isIdentifier(node) && !seen.has(node.text) && initializers.has(node.text)) {
      seen.add(node.text); return states(initializers.get(node.text), seen);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(value => states(value, new Set(seen)));
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(property =>
      property.name && sqlState(ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(tree)));
    if (ts.isNewExpression(node) && node.expression.getText(tree) === "Set" && node.arguments?.[0])
      return states(node.arguments[0], seen);
    return false;
  }
  const hits = [];
  const add = node => hits.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    expression: node.getText(tree).replace(/\s+/gu, " ") });
  function visit(node) {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(node.operatorToken.kind)
      && ((readsCode(node.left) && states(node.right)) || (readsCode(node.right) && states(node.left)))) add(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["includes", "indexOf", "has"].includes(node.expression.name.text) && node.arguments[0]
      && ((states(node.expression.expression) && readsCode(node.arguments[0]))
        || (readsCode(node.expression.expression) && states(node.arguments[0])))) add(node);
    if (ts.isSwitchStatement(node) && readsCode(node.expression)
      && node.caseBlock.clauses.some(clause => ts.isCaseClause(clause) && states(clause.expression))) add(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return hits;
}
