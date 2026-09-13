import assert from "node:assert/strict";
import { test } from "node:test";
import { prepared } from "./owner-bootstrap-ceremony-helper";

test("control timeout, abort across delivery boundaries, and cleanup uncertainty invalidate the code", async t => {
  // Four databases are isolated in this process; no additional fixture is created here.
  for (const kind of ["timeout", "abort-write", "abort-cleanup", "cleanup-timeout"] as const) {
    const x = await prepared(); t.after(() => x.raw.close());
    const controller = new AbortController(); let releaseWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>(resolve => { releaseWrite = resolve; });
    const attempt = kind === "timeout" || kind === "abort-write" ? x.attempt({ writeCode: (_code, signal) => new Promise((_, reject) => {
      releaseWrite?.(); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) }) : kind === "abort-cleanup" ? x.attempt({ async close() { controller.abort(); } })
      : x.attempt({ close: () => new Promise(() => {}) });
    const armed = x.ceremony.arm(attempt, controller.signal);
    if (kind === "abort-write") { await writeStarted; controller.abort(); }
    await assert.rejects(armed, /uncertain|unavailable/);
    assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
    assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "0");
  }
});
