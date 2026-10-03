import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

// Keep each invocation separate: a preload on one side of && cannot load the other.
const shellTokens = /"[^"]*"|'[^']*'|&&|\|\||[;|\n]|[^\s;&|]+/g;
const unquote = value => value.replace(/^(["'])(.*)\1$/, "$2");

function importsTypeScript(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = node => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? node.arguments[0] : undefined;
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))
      && /\.(?:[cm]?ts|tsx)$/.test(specifier.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

export function testLoaderErrors(scripts, root = process.cwd()) {
  const errors = [];
  for (const [name, source] of Object.entries(scripts)) {
    const commands = source.match(shellTokens)?.reduce((commands, token) => {
      if (/^(?:&&|\|\||[;|\n])$/.test(token)) commands.push([]);
      else commands.at(-1).push(unquote(token));
      return commands;
    }, [[]]) ?? [];
    for (const args of commands) {
      if (!args.includes("node") || !args.includes("--test")) continue;
      const files = args.filter(arg => /\.(?:[cm]?ts|tsx|mjs|js)$/.test(arg) && !arg.startsWith("--"));
      const needsLoader = files.some(file => {
        if (/\.(?:[cm]?ts|tsx)$/.test(file)) return true;
        // JS tests can load TS too (the production lane's original regression).
        // Only literal module specifiers count, not arbitrary quoted filenames.
        if (!/\.test\.(?:mjs|js)$/.test(file)) return false;
        return importsTypeScript(file, readFileSync(join(root, file), "utf8"));
      });
      if (!needsLoader) continue;
      const testIndex = args.indexOf("--test");
      const fileIndex = args.findIndex((arg, index) => index > testIndex && files.includes(arg));
      const importIndex = args.findIndex((arg, index) =>
        arg === "--import=tsx" || (arg === "--import" && args[index + 1] === "tsx"));
      if (importIndex < 0 || (fileIndex >= 0 && importIndex > fileIndex)) {
        errors.push(`${name}: TypeScript tests require --import tsx before test files`);
      }
    }
  }
  return errors;
}

export function repositoryTestLoaderErrors(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "package.json", "**/package.json"],
    { cwd: root, encoding: "utf8", timeout: 10_000 }).split("\0").filter(Boolean);
  return files.flatMap(file => {
    const scripts = JSON.parse(readFileSync(join(root, file), "utf8")).scripts ?? {};
    return testLoaderErrors(scripts, join(root, file, "..")).map(error => `${file}: ${error}`);
  });
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  const errors = repositoryTestLoaderErrors();
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log("all package TypeScript test invocations preload tsx");
}
