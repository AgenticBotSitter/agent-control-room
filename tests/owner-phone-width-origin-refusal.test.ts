// The live-app refusal, proven rather than asserted in a comment.
//
// The phone-width suite signs in as the owner and creates a real project and a
// real task. Run against the live app on port 3210 it would write to the
// owner's live database. The refusal that prevents this used to be an inline
// `if` in the Playwright spec: the review removed the `|| port === "3210"`
// condition, re-ran Playwright discovery, and the command exited 0 and listed
// the test. A guard whose deletion is invisible to CI is not a guard.
//
// So the guard is `assertDisposableBrowserOrigin` in
// `private-app/app/browser-test-origin.ts`, and this file checks three
// separate things, because each can fail on its own:
//
//   1. the guard refuses 3210, with the exact message, for every spelling of
//      that origin a suite might be pointed at;
//   2. the guard still refuses the neighbouring non-disposable cases, so
//      "refuse 3210" was not implemented as "refuse everything";
//   3. the spec actually calls the guard. (1) and (2) pass against a guard
//      nobody invokes — a perfect, correctly-messaged dead function. Only (3)
//      fails in that case, which is precisely the mutation that previously
//      survived, so it is the mutation this file is written to catch.
//
// A real subprocess check runs too, because the review's mutation was applied
// to the spec and observed through Playwright discovery. Import-time refusal
// and discovery-time refusal are the same mechanism here, but the subprocess
// proves the failure actually reaches a caller as a nonzero exit rather than
// only throwing inside this process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PHONE_WIDTH_BROWSER_REFUSAL, assertDisposableBrowserOrigin,
  parseDisposableBrowserOrigin } from "../private-app/app/browser-test-origin";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the live app on port 3210 is refused however the origin is spelled", () => {
  // Every spelling a suite, a shell or a CI variable can actually produce. A
  // check that only matched the canonical form would be one refactor away from
  // letting the live app through.
  for (const origin of [
    "http://127.0.0.1:3210",
    "http://127.0.0.1:3210/",
    "http://127.0.0.1:3210/session",
    "http://localhost:3210",
    "http://127.0.0.1:3210?owner=1",
    "http://127.0.0.1:3210#projects",
  ]) {
    assert.throws(() => assertDisposableBrowserOrigin(origin), (error: Error) => {
      assert.equal(error.message, PHONE_WIDTH_BROWSER_REFUSAL,
        `${origin} must be refused with the exact refusal message`);
      return true;
    }, `${origin} is the live app and must never be a browser-suite target`);
  }
});

test("non-loopback and non-http origins are refused, so 3210 is not the only refusal", () => {
  // If the guard refused only 3210 then a DNS name pointing at the live host
  // would be allowed through, and these assertions exist to prove the guard is
  // "a disposable loopback origin only", not "not 3210".
  for (const origin of [
    undefined, "", "not a url", "http://control.example.com:3220",
    "https://127.0.0.1:3220", "http://[::1]:3220", "http://127.0.0.2:3220",
    "http://evil.test/http://127.0.0.1:3220", "file:///etc/passwd",
  ]) {
    assert.throws(() => assertDisposableBrowserOrigin(origin),
      (error: Error) => { assert.equal(error.message, PHONE_WIDTH_BROWSER_REFUSAL); return true; },
      `${String(origin)} is not a disposable loopback origin and must be refused`);
  }
});

test("a disposable loopback origin is accepted, so the guard is not simply refuse-everything", () => {
  // Without this, a guard that always threw would satisfy both tests above.
  // The rehearsal lanes pass exactly these shapes.
  for (const origin of ["http://127.0.0.1:3219", "http://127.0.0.1:3221/", "http://127.0.0.1:15503"]) {
    const parsed = assertDisposableBrowserOrigin(origin);
    assert.equal(parsed.hostname, "127.0.0.1");
    assert.ok(parsed.port.length > 0, "a refused-at-load stack always carries a port");
  }
  // Both exports must apply the same rule, so a suite cannot import the laxer
  // spelling of the guard. Compared by behaviour, not by reference, because
  // only one of the two is a named function.
  const disagreements = ["http://127.0.0.1:3210", "http://127.0.0.1:3219", "", "http://localhost:3219"];
  for (const origin of disagreements) {
    let parseRefused = false, assertRefused = false;
    try { parseDisposableBrowserOrigin(origin); } catch { parseRefused = true; }
    try { assertDisposableBrowserOrigin(origin); } catch { assertRefused = true; }
    assert.equal(parseRefused, assertRefused,
      `${String(origin)}: the two exports disagree, so a suite could pick the laxer one`);
  }
});

test("the phone-width spec calls the guard instead of repeating it inline", () => {
  // The mutation that previously survived: delete the refusal from the spec
  // and CI stays green. This is the assertion that makes that mutation fail.
  const spec = readFileSync(new URL("browser/owner-phone-width.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /assertDisposableBrowserOrigin\s*\(\s*process\.env\.CONTROL_ROOM_E2E_ORIGIN\s*\)/,
    "tests/browser/owner-phone-width.spec.ts must call the shared guard with the suite's origin");
  // And the guard must run before any test is declared, or discovery would
  // register the test and only then fail.
  const guardAt = spec.indexOf("assertDisposableBrowserOrigin(process.env.CONTROL_ROOM_E2E_ORIGIN)");
  const firstTestAt = spec.search(/^test\(/m);
  assert.ok(guardAt > -1 && firstTestAt > guardAt,
    `the guard must run at module scope, before the first test() (guard at ${guardAt}, first test at ${firstTestAt})`);
  // No *code* may name the live-app port in the spec. A leftover inline
  // condition is the exact weaker guard the review mutated, and two guards are
  // worse than one. The prose header mentions the port while explaining what is
  // being refused, so only the code after the last import is inspected.
  const code = spec.slice(spec.lastIndexOf("import "));
  assert.doesNotMatch(code, /\b3210\b/,
    "the live-app port must be named only in browser-test-origin.ts, never in spec code");
});

test("the refusal reaches a caller as a nonzero exit, not only as a throw", () => {
  // The review observed the refusal through Playwright discovery. This runs the
  // same import in a child process pointed at 3210 and requires a nonzero exit
  // carrying the exact message, so "it threw" is provably "the run failed".
  let failed = false;
  try {
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      "import { assertDisposableBrowserOrigin } from './private-app/app/browser-test-origin.ts';" +
      " assertDisposableBrowserOrigin(process.env.CONTROL_ROOM_E2E_ORIGIN);"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe",
        env: { ...process.env, CONTROL_ROOM_E2E_ORIGIN: "http://127.0.0.1:3210" } });
  } catch (error) {
    failed = true;
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    assert.ok(stderr.includes(PHONE_WIDTH_BROWSER_REFUSAL),
      `the child must print the exact refusal, got: ${stderr.slice(0, 400)}`);
  }
  assert.ok(failed, "pointed at the live app, importing the guard must fail the process");
});
