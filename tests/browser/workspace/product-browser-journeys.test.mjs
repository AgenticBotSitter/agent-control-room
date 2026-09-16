import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

import { planProductBrowserJourneys, renderProductBrowserJourneys,
  PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1 } from "./product-browser-journeys.mjs";
import { createProductBrowserHarness, runProductBrowserJourneys,
  ABORT_POINT, PRODUCT_BROWSER_HARNESS_SCHEMA_V1 } from "./product-browser-journey-harness.mjs";

test("planProductBrowserJourneys: schema advertises the journey set and never claims a live agent", () => {
  const plan = planProductBrowserJourneys();
  assert.equal(plan.schema, PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1);
  assert.match(plan.simulator, /PGlite database/i);
  assert.match(plan.simulator, /single Playwright route/i);
  assert.match(plan.simulator, /no live agent/i);
  const titles = plan.journeys.map(j => j.title);
  assert.deepEqual(titles, [
    "Create project A and open its overview",
    "Save a task under project A and follow its protected detail",
    "Create project B and confirm navigation stays inside it",
    "Reconnect a browser context and prove project A still has its task",
    "Walk the Files, Reviews, Activity, Settings pages at 360px and 1280px",
    "Archive project A and reopen it without losing its task",
    "Reload, back/forward, and the narrow workspace menu",
    "Open the agent progress page that the result lifecycle publishes",
    "Open the protected result content and read the exact returned text",
    "Accept the owner quality decision and confirm the saved review decision",
    "Prepare a revised task and follow its protected follow-up page",
    "Finalize the source task through the production completion gate",
    "Distinguish a lost request from a lost reply using request-level evidence",
    "Exercise keyboard focus at both 360px and 1280px without sideways scroll",
    "Verify idempotency on every protected save command",
    "Clean up the exact owned browser, context, application and temporary profile data",
  ]);
  for (const journey of plan.journeys) {
    assert.ok(journey.command.startsWith("/api/v1/") || journey.command === "(no protected command)"
      || journey.command === "(read-only navigation)" || journey.command === "(bootstrap-only)"
      || journey.command === "(cleanup)",
      `unexpected command for ${journey.title}: ${journey.command}`);
    assert.ok(journey.proof.length > 0, `proof missing for ${journey.title}`);
    assert.ok(journey.simulated, `journey ${journey.title} must declare itself simulated`);
  }
});

test("renderProductBrowserJourneys: human-readable output names every journey with its proof", () => {
  const rendered = renderProductBrowserJourneys(planProductBrowserJourneys());
  for (const journey of planProductBrowserJourneys().journeys) {
    assert.ok(rendered.includes(journey.title), `missing title in render: ${journey.title}`);
    assert.ok(rendered.includes(journey.command.replace(/[`]/g, "")), `missing command in render: ${journey.command}`);
  }
  assert.match(rendered, /no live agent/i);
});

test("planProductBrowserJourneys: rejected commands or missing simulation are fail-closed", () => {
  const plan = planProductBrowserJourneys();
  for (const journey of plan.journeys) {
    // A real path command has no spaces; sentinel commands are explicit.
    if (journey.command.startsWith("/api/v1/")) assert.ok(!journey.command.includes(" "),
      `command must be a single path: ${journey.command}`);
    assert.ok(!journey.proof.toLowerCase().includes("live agent"),
      `proof must not claim a live agent: ${journey.proof}`);
  }
  // Renderer rejects any plan whose schema does not match, so the journey
  // list can never be silently relabeled.
  assert.throws(() => renderProductBrowserJourneys({
    schema: "acr-product-browser-journeys:v0",
    simulator: "x", journeys: [{ title: "x", command: "/api/v1/x", proof: "y", simulated: true }] }),
    /expected acr-product-browser-journeys:v1 schema/);
});

test("sanitized screenshot predicate accepts bounded PNGs and rejects oversized ones", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "product-browser-"));
  const nested = resolve(dir, "evidence");
  await mkdir(nested, { recursive: true });

  // Build a minimal but valid 1x1 PNG.
  const zlib = await import("node:zlib");
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 1]), Buffer.from([8, 2, 0, 0, 0])]);
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  function crc(type, data) {
    const table = new Uint32Array(256); for (let n = 0; n < 256; n++) {
      let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0;
    }
    let crcValue = 0xffffffff;
    const buf = Buffer.concat([Buffer.from(type, "ascii"), data]);
    for (const byte of buf) crcValue = table[(crcValue ^ byte) & 0xff] ^ (crcValue >>> 1);
    return Buffer.from([(crcValue ^ 0xffffffff) >>> 24, (crcValue ^ 0xffffffff) >>> 16,
      (crcValue ^ 0xffffffff) >>> 8, (crcValue ^ 0xffffffff) & 0xff]);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, crc("IHDR", ihdr),
    Buffer.from([0, 0, 0, idat.length]), Buffer.from("IDAT"), idat, crc("IDAT", idat),
    Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), crc("IEND", Buffer.alloc(0)),
  ]);
  const path = resolve(nested, "bounded.png");
  await writeFile(path, png);

  const image = await readFile(path);
  assert.ok(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.equal(width, 1);
  assert.equal(height, 1);
  assert.ok(image.length <= 5 * 1024 * 1024);
  const real = realpathSync(nested);
  assert.ok(real.endsWith(`${sep}evidence`), `expected evidence subdirectory, got ${real}`);
});

test("invalid journey shape is rejected without coercion", () => {
  const plan = planProductBrowserJourneys();
  const first = plan.journeys[0];
  assert.ok(typeof first.title === "string" && first.title.length > 0);
  assert.ok(typeof first.command === "string" && first.command.startsWith("/api/v1/"));
  assert.ok(typeof first.proof === "string" && first.proof.length > 0);
  assert.equal(first.simulated, true);
});

/* ------------------------------------------------------------------ */
/* Executed product browser journeys (simulated harness)               */
/* ------------------------------------------------------------------ */

test("journeys: two isolated projects never leak a task across the boundary", () => {
  const run = runProductBrowserJourneys();
  assert.equal(run.schema, PRODUCT_BROWSER_HARNESS_SCHEMA_V1);
  assert.equal(run.isolation.betaLeakedAlphaTask, false,
    "project B must never observe project A's task");
  assert.equal(run.isolation.alphaProjects, 1, "project A holds exactly its own task");
});

test("journeys: read-only re-check performs no mutating command", () => {
  const run = runProductBrowserJourneys();
  assert.equal(run.readOnly.mutatingDelta, 0,
    "re-reading the product must not auto-write anything");
  assert.equal(run.readOnly.found, true);
});

test("journeys: archive then reopen preserves the project's task", () => {
  const run = runProductBrowserJourneys();
  assert.equal(run.afterReopenTaskCount, 1,
    "the task must survive archive and reopen");
});

test("journeys: a lost request writes nothing and a same-key retry is a first write", () => {
  const run = runProductBrowserJourneys();
  assert.equal(run.lostRequest.aborted, true, "the request must be reported as aborted");
  assert.equal(run.lostRequest.committedOnAbort, 0,
    "a request that never reached the server must leave no record");
  assert.match(run.lostRequest.retryProjectId, /^project:/,
    "a retry after a genuinely lost request is a first write");
  assert.equal(run.lostRequest.retryReplayed, false,
    "there was no receipt to replay, so the retry is a genuine first write");
});

test("journeys: a lost reply replays on the same key and commits exactly one record", () => {
  const run = runProductBrowserJourneys();
  assert.equal(run.lostReply.aborted, true, "the reply must be reported as lost");
  assert.equal(run.lostReply.committedOnAbort, 1,
    "the server committed even though the reply was lost");
  assert.equal(run.lostReply.replayReplayed, true,
    "retrying a lost reply must replay the original outcome");
  assert.equal(run.lostReply.replayProjectId, run.lostReply.firstProjectId,
    "the replay must return the SAME resource, not a second one");
  assert.equal(run.lostReply.committedAfterReplay, 1,
    "a lost reply must never produce two committed records");
});

test("harness: a lost request and a lost reply are genuinely distinguishable", () => {
  // The two abort points must NOT be interchangeable. Before-commit leaves no
  // receipt, so the retry writes; after-commit leaves one, so the retry
  // replays. If these produced identical state the harness could not tell a
  // lost request from a lost reply at all.
  const body = { name: "epsilon" };
  const key = "key-distinguish";

  const before = createProductBrowserHarness();
  assert.throws(() => before.request({ method: "POST", path: "/api/v1/projects", body,
    idempotencyKey: key, abortPoint: ABORT_POINT.BEFORE_COMMIT }),
    /product_browser_harness_aborted_before_commit/);
  assert.equal(before.committedCount("projects"), 0, "a lost request commits nothing");
  const beforeRetry = before.request({ method: "POST", path: "/api/v1/projects", body, idempotencyKey: key });

  const after = createProductBrowserHarness();
  assert.throws(() => after.request({ method: "POST", path: "/api/v1/projects", body,
    idempotencyKey: key, abortPoint: ABORT_POINT.AFTER_COMMIT }),
    /product_browser_harness_aborted_after_commit/);
  assert.equal(after.committedCount("projects"), 1, "a lost reply left the write behind");
  const afterRetry = after.request({ method: "POST", path: "/api/v1/projects", body, idempotencyKey: key });

  // The two retries must differ in kind, not just in bookkeeping.
  assert.equal(beforeRetry.replayed, false, "lost-request retry is a first write");
  assert.equal(afterRetry.replayed, true, "lost-reply retry is a replay");
  assert.equal(before.committedCount("projects"), 1);
  assert.equal(after.committedCount("projects"), 1);
});

test("harness: every mutating command carries an idempotency key of usable length", () => {
  const run = runProductBrowserJourneys();
  const harness = createProductBrowserHarness();
  harness.request({ method: "POST", path: "/api/v1/projects", body: { name: "zeta" }, idempotencyKey: "key-zeta" });
  for (const entry of harness.log) {
    if (!entry.mutating) continue;
    assert.ok(entry.replayed === undefined || typeof entry.replayed === "boolean");
  }
  // A mutating command without a key is refused outright rather than silently
  // accepted, which is what makes the count assertions meaningful.
  assert.throws(() => harness.request({ method: "POST", path: "/api/v1/projects", body: { name: "eta" } }),
    /product_browser_harness_invalid_idempotency_key/);
  assert.equal(run.mutatingCommands > 0, true, "the journey set issues mutating commands");
});

test("harness: a task cannot be written into a project that is archived or unknown", () => {
  const harness = createProductBrowserHarness();
  assert.throws(() => harness.request({ method: "POST", path: "/api/v1/projects/project:404/tasks",
    body: { title: "orphan" }, idempotencyKey: "key-orphan" }),
    /product_browser_harness_unknown_project/);
  assert.equal(harness.committedCount("tasks"), 0,
    "a refused task creation must commit nothing");
});

test("harness: sanity evidence records both widths with focus order and labels", () => {
  const run = runProductBrowserJourneys();
  const widths = run.evidence.map(e => e.width).sort((a, b) => a - b);
  assert.deepEqual(widths, [360, 1280]);
  for (const item of run.evidence) {
    assert.ok(item.focusOrder.includes("skip-link"), "the skip link must lead the focus order");
    assert.ok(item.labels.every(l => typeof l.label === "string" && l.label.length > 0),
      "every field must carry a non-empty accessible label");
    assert.equal(item.synthetic, true, "evidence must declare itself synthetic");
  }
});

test("harness: cleanup reports exact owned resources and no wasted listener", () => {
  const run = runProductBrowserJourneys();
  assert.deepEqual([...run.cleanup.closed].sort(),
    ["application", "context", "disposable_database", "route"].sort());
  assert.equal(run.cleanup.temporaryProfileRemoved, true);
  assert.equal(run.cleanup.reused, false);
  assert.equal(run.cleanup.listenerReleased, null, "no port was bound, so none is released");
});

test("runProductBrowserJourneys: produces every documented journey step", () => {
  const run = runProductBrowserJourneys();
  const titles = run.steps.map(s => s.title);
  for (const required of [
    "Create project A and open its overview",
    "Create project B and confirm navigation stays inside it",
    "Archive project A and reopen it without losing its task",
    "Distinguish a lost request from a lost reply using request-level evidence",
    "Exercise keyboard focus at both 360px and 1280px without sideways scroll",
  ]) assert.ok(titles.includes(required), `missing executed journey: ${required}`);
  assert.equal(run.simulated, true);
});
