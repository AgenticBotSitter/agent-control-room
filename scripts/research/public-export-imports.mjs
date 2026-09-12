import ts from 'typescript';

// Uses the installed compiler parser; never evaluates the scanned source.
export function publicExportImports(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [], dynamic = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression))
      imports.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      else dynamic.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports: [...new Set(imports)], dynamic };
}

// Build entry strings are not imports. Inspect the config without executing plugins.
export function publicExportBuildEntries(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const entries = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'input') {
      if (!ts.isObjectLiteralExpression(node.initializer)) throw new Error('Nonliteral build input requires review');
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
          throw new Error('Nonliteral build entry requires review');
        const value = property.initializer.text;
        if (!/^src\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/.test(value) || value.split('/').includes('..'))
          throw new Error('Unexpected build entry requires review');
        entries.push(value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!entries.length) throw new Error('No build entries found');
  return [...new Set(entries)].sort();
}
