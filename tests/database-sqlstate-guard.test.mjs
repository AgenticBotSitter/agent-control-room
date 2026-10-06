import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sqlStateCodeComparisons } from "./support/sqlstate-guard.mjs";
import { isSqlStateCodeV1 } from "../src/persistence/node-errno-sqlstate.mjs";

// Exact existing raw-driver checks. Each entry permits one expression, not a file
// or directory. New expressions (even in these files) must use the shared helper.
const rawDriverExceptions = new Map([
  ["deploy/postgres/apply-migrations.mjs", ['error?.code !== "42P01"', 'error?.code !== "42883"']], // raw pg migration runner
  ["scripts/mac-local/fixed-queue-schema.mjs", ['error?.code === "42P01"', 'error?.code === "42703"']], // raw pg upgrade runner
  ["scripts/mac-local/check-database.ts", ['(error as { code?: unknown }).code === "42501"']], // raw pg permission probe
  ["src/updater/v1/store.mjs", ['error?.code === "42501"']], // raw pg updater, message disambiguates lease loss
  ["src/updater/v1/passkey-store.mjs", ['error?.code === "42501"']], // raw pg updater, message disambiguates approval refusal
  ["src/web/v1/private-rehearsal-checks.ts", ['error.code !== "42501"']], // dedicated RehearsalProbeError
  ["src/web/v1/private-rehearsal-probe.ts", ['["42501", "55P03", "57014", "25P04"].includes(code as string)', 'code === "25P04"']], // raw pg -> dedicated probe error
]);

test("production SQLSTATE checks never compare driver code outside reviewed raw-driver exceptions", () => {
  const unexpected = [], remaining = new Map([...rawDriverExceptions].map(([file, expressions]) => [file, [...expressions]]));
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/u.test(file)) {
        // The helper is the one place allowed to read either adapter's field.
        if (file === "src/persistence/database.ts") continue;
        for (const hit of sqlStateCodeComparisons(readFileSync(file, "utf8"), file)) {
          // The private driver is itself the raw-pg sanitization seam, not a store.
          const exceptions = remaining.get(file) ?? [];
          const index = exceptions.indexOf(hit.expression);
          if (index < 0) unexpected.push(`${file}:${hit.line}: ${hit.expression}`);
          else exceptions.splice(index, 1);
        }
      }
    }
  };
  for (const root of ["src", "scripts", "deploy", "app", "private-app", "contributor-demo"]) visit(root);
  assert.deepEqual(unexpected, [], "Use databaseSqlStateIsAnyV1; raw .code misses the bounded driver's sqlState");
  assert.deepEqual([...remaining].filter(([, expressions]) => expressions.length), [], "Remove stale raw-driver exceptions");
});

test("guard catches equality, optional/cast/bracket access, reverse comparisons, aliases, sets and switches", () => {
  for (const source of [
    'error.code === "23505"', '(error as { code?: string })?.code !== "42P01"',
    '"P0001" == error["code"]', '["23503", "23505"].includes(error?.code)',
    'switch (error.code) { case "42501": break; }',
    'const state = error.code; state === "23505"',
    'const states = ["23505"]; states.includes(error.code)',
    'error.code in { "23505": true }',
    'new Set(["23505"]).has(error.code)',
    'const state = Reflect.get(error, "code"); state === "23505"',
    'const state = error ? error.code : undefined; state === "23505"',
    'const state = error.code ?? "unknown"; state === "23505"',
  ]) assert.equal(sqlStateCodeComparisons(source).length, 1, source);
  for (const source of ['error.code === "ENOENT"', 'error.code === "EPIPE"',
    'databaseSqlStateIsAnyV1(error, ["23505"])', '// error.code === "23505"',
    'error.code === "235050"', 'error.code === "lowercase"', 'error.code === "database_unavailable"',
    'const text = `error.code === "23505"`']) assert.equal(sqlStateCodeComparisons(source).length, 0, source);
});

// The guard must agree with the reader it polices about what a SQLSTATE IS. It
// used to carry its own "no code starts with E" rule, which is exactly how the
// two could drift with nothing failing; mutation M6 (the guard reverted to the
// prefix rule) survived every other test in the tree before this one existed.
test("the guard classifies codes by the shared reader's test, never its own rule", () => {
  const source = readFileSync("tests/support/sqlstate-guard.mjs", "utf8");
  assert.match(source, /import \{ isSqlStateCodeV1 \} from "\.\.\/\.\.\/src\/persistence\/node-errno-sqlstate\.mjs"/u,
    "the guard must take its accept test from the shared module, by construction");
  assert.match(source, /const sqlState = value => isSqlStateCodeV1\(value\)/u);
  // A second rule of its own is the drift this pins, so the shared shape must
  // not be restated as a regex here.
  assert.doesNotMatch(source, /\^\[0-9A-Z\]\{5\}\$/u,
    "the SQLSTATE shape belongs to the shared module, not to the guard");
  assert.doesNotMatch(source, /startsWith\("E"\)/u,
    "the E-prefix rule is the reviewed bug; it must not survive anywhere");
  // And the two agree on every code that matters, in both directions: a real
  // server code the reader accepts must be one the guard is willing to flag as a
  // raw comparison, and a Node errno must be one neither treats as a code.
  for (const code of ["23505", "23P01", "42501", "P0001", "40P01", "55P03", "E1234", "EXX99", "X1234"])
    assert.equal(sqlStateCodeComparisons(`error.code === "${code}"`).length, 1, code);
  for (const code of ["EPIPE", "EPERM", "ESRCH", "ENOENT", "ECONNRESET"])
    assert.equal(sqlStateCodeComparisons(`error.code === "${code}"`).length, 0, code);
  assert.equal(isSqlStateCodeV1("E1234"), true);
  assert.equal(isSqlStateCodeV1("EPIPE"), false);
});
