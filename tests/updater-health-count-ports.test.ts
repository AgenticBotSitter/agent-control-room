// Unit tests for the two typed health-count ports (design \u00a78.4 item 2). The
// real-PostgreSQL proof of the DATABASE side is
// tests/updater-health-counts-postgres.test.ts; this file covers the two
// adapters' own contract -- what they accept, what they refuse, and what they are
// incapable of returning.
//
// What is under test:
//   * the updater's authority port re-captures node-pg's stringified bigint, so
//     the \u00a78.4 comparison against the signed web response is number-to-number
//     and a healthy release is not failed by "3" !== 3;
//   * it refuses a malformed count, an extra column, a missing column, no row,
//     and more than one row;
//   * the web port runs the three REAL reads, renders the real Home route,
//     measures the web login's INSERT privilege, and refuses when any of those
//     fails -- including an error page that renders successfully;
//   * neither port can return a name, an id, a path or a payload.
import assert from "node:assert/strict";
import test from "node:test";
import { createUpdaterHealthAuthorityReadPortV1 } from "../src/updater/v1/health-authority-reads";
import { createUpdaterHealthWebReadPortV1 } from "../src/web/v1/updater-health-web-reads";

const SCOPE = { tenantId: "tenant:port", workspaceId: "workspace:port" };
const COUNT_COLUMNS = { home_summary_count: "3", project_count: "2", updates_panel_count: "1" };

/** A connection whose single statement answers exactly what the test says. */
function connection(rows: Record<string, unknown>[]) {
  const statements: string[] = [];
  return {
    statements,
    query: async <T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
      statements.push(sql);
      return { rows: rows as T[] };
    },
  };
}

const identity = { provider: "local", subject: "owner", tokenDigest: "sha256:0".repeat(1) + "0".repeat(63),
  issuedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T01:00:00.000Z",
  verificationExpiresAt: "2026-09-30T01:00:00.000Z" } as never;

test("the authority port returns the three counts as numbers, from one statement", async () => {
  const db = connection([COUNT_COLUMNS]);
  const port = createUpdaterHealthAuthorityReadPortV1(db);
  assert.deepEqual(await port.readHealthCounts(),
    { homeSummaryCount: 3, projectCount: 2, updatesPanelCount: 1 });
  assert.equal(db.statements.length, 1, "one round trip, not three");
  // Schema-qualified, no parameters: there is nothing for a caller to vary.
  assert.match(db.statements[0]!, /^SELECT home_summary_count, project_count, updates_panel_count/u);
  assert.match(db.statements[0]!, /FROM public\.updater_health_counts\(\)/u);
  assert.equal(db.statements[0]!.includes("$1"), false, "no parameter means no caller-chosen scope");
});

test("the authority port refuses anything that is not exactly three safe-integer counts", async () => {
  const refused = [
    // [what is wrong, the row the driver returns, the refusal that must be named]
    ["a non-numeric count", { ...COUNT_COLUMNS, project_count: "two" }, "project_count"],
    ["an empty count", { ...COUNT_COLUMNS, project_count: "" }, "project_count"],
    ["a count with a sign", { ...COUNT_COLUMNS, project_count: "+2" }, "project_count"],
    // These three are the ones the RANGE check cannot catch: Number("0003") is 3 and
    // Number("1e3") is 1000, both inside the accepted range, so only the digit
    // SPELLING check refuses them.
    ["a zero-padded count", { ...COUNT_COLUMNS, project_count: "0003" }, "project_count"],
    ["an exponent count", { ...COUNT_COLUMNS, project_count: "1e3" }, "project_count"],
    ["a hexadecimal count", { ...COUNT_COLUMNS, project_count: "0x3" }, "project_count"],
    ["a padded count", { ...COUNT_COLUMNS, project_count: " 2" }, "project_count"],
    ["a float count", { ...COUNT_COLUMNS, project_count: "2.0" }, "project_count"],
    ["a negative count", { ...COUNT_COLUMNS, project_count: "-1" }, "project_count"],
    ["an unbounded count", { ...COUNT_COLUMNS, project_count: "1000001" }, "project_count"],
    ["a null count", { ...COUNT_COLUMNS, updates_panel_count: null }, "updates_panel_count"],
    // An extra column is what a future migration adding one would produce, and it must
    // refuse here rather than flow into the signed health response. The value is a
    // plausible digest so only the SHAPE check can be what refuses it.
    ["an extra column", { ...COUNT_COLUMNS, owner_session_digest: "sha256:" + "a".repeat(64) }, "shape"],
    ["a missing column", { home_summary_count: "3", project_count: "2" }, "shape"],
    ["a renamed column", { ...COUNT_COLUMNS, home: "1" }, "shape"],
  ] as const;
  // No row at all, and more than one, are refusals in their own right and are
  // asserted here rather than through the table above, because they are about how
  // many rows came back rather than what is in one.
  await assert.rejects(createUpdaterHealthAuthorityReadPortV1(connection([])).readHealthCounts(),
    /^Error: updater_health_authority_counts_refused:no_row$/u, "no row must refuse");
  await assert.rejects(createUpdaterHealthAuthorityReadPortV1(connection([COUNT_COLUMNS, COUNT_COLUMNS])).readHealthCounts(),
    /^Error: updater_health_authority_counts_refused:row_count$/u, "two rows must refuse");
  // The reason must be the one this case is about, not merely SOME refusal: an
  // earlier version matched only the error PREFIX, and every case was in fact being
  // refused by the ROW-COUNT check (a single row object is not an array of rows),
  // so deleting the count validation entirely left the whole test green. Asserting
  // the exact reason is what makes these cases able to fail for their own reason.
  for (const [why, row, expected] of refused)
    await assert.rejects(createUpdaterHealthAuthorityReadPortV1(connection([row] as never)).readHealthCounts(),
      new RegExp(`^Error: updater_health_authority_counts_refused:${expected}$`, "u"),
      `must refuse ${why} for ${expected}`);
});

test("the authority port refuses a connection that is not one", () => {
  assert.throws(() => createUpdaterHealthAuthorityReadPortV1(undefined as never),
    /^Error: updater_health_authority_connection_invalid/u);
  assert.throws(() => createUpdaterHealthAuthorityReadPortV1({} as never),
    /^Error: updater_health_authority_connection_invalid/u);
});

// The rendered body deliberately contains no word that appears in the RESULT's
// own field names, so "did the port leak the render?" is a real question rather
// than a match against `homeSummaryCount`.
const REAL_HOME = "<html>owner-dashboard-7f3a</html>";

/** A web-port composition whose every input the test controls. Overrides are
 * MERGED per key, not spread over the whole object, so a test that overrides only
 * `privilege` still gets a working `home`. */
function webPort(overrides: Record<string, Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const input = {
    reads: {
      home: async () => { calls.push("home"); return { active: [1, 2], recentResults: [3] }; },
      projects: async () => { calls.push("projects"); return [{ id: "p1" }, { id: "p2" }]; },
      updatesPanel: async () => { calls.push("panel"); return { candidates: [{ id: "c1" }] }; },
      ...overrides.reads,
    },
    home: {
      identity: async () => { calls.push("identity"); return identity; },
      render: async () => { calls.push("render"); return new Response(REAL_HOME,
        { status: 200, headers: { "content-type": "text/html" } }); },
      ...overrides.home,
    },
    privilege: { hasPlanApprovalInsert: async () => { calls.push("privilege"); return true; },
      ...overrides.privilege },
  };
  // An override that removes a whole key (rather than replacing a member of it)
  // is how the incomplete-composition cases are expressed.
  for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete (input as never)[key];
  return { port: createUpdaterHealthWebReadPortV1(input as never), calls };
}

test("the web port counts the three real reads and reports only numbers", async () => {
  const { port, calls } = webPort();
  const counts = await port.readHealthCounts(SCOPE);
  assert.deepEqual(counts, { homeSummaryCount: 3, projectCount: 2, updatesPanelCount: 1,
    homeRenderBytes: REAL_HOME.length,
    planApprovalInsertAllowed: true });
  assert.deepEqual(calls, ["identity", "home", "projects", "panel", "render", "privilege"],
    "the three reads run in order on one identity, then the render, then the measurement");
  // Nothing that could name a row, a person or a path may leave this port.
  const text = JSON.stringify(counts);
  for (const secret of ["tenant:port", "workspace:port", "owner-dashboard-7f3a", "p1", "c1", "<html>"])
    assert.equal(text.includes(secret), false, `the web port leaked ${secret}`);
});

test("the web port refuses a failed render, and a successful error page", async () => {
  for (const [why, response] of [
    ["a 500", new Response("boom", { status: 500 })],
    ["a 403", new Response("no", { status: 403 })],
    ["a redirect", new Response(null, { status: 303 })],
    ["an empty 200", new Response("", { status: 200 })],
  ] as const)
    await assert.rejects(webPort({ home: { render: async () => response } })
      .port.readHealthCounts(SCOPE), /^Error: updater_health_web_reads_refused:/u, `must refuse ${why}`);
  // An error page that renders with 200 is the case a status check alone misses.
  // The empty-200 refusal above is the SIZE bound, not a side effect: it must be
  // proven independently of the status check, and the implausibly-large render the
  // same bound rejects is asserted too, so removing either half of that bound is
  // caught. (Dropping `size < 1 || size > 4_194_304` left the empty case passing
  // before this test existed, because 0 is itself a safe integer.)
  await assert.rejects(webPort({ home: { render: async () => new Response("x".repeat(1_000_001), { status: 200 }) } })
    .port.readHealthCounts(SCOPE), /^Error: updater_health_web_reads_refused:home_render_size/u,
    "a render past the byte ceiling is not a healthy page");
  const healthy = await webPort().port.readHealthCounts(SCOPE);
  assert.ok(healthy.homeRenderBytes > 0, "a real render reports a non-empty byte count");
  // And the boundary values themselves are accepted, so the bound is not off by one.
  assert.equal((await webPort({ home: { render: async () => new Response("x".repeat(1_000_000), { status: 200 }) } })
    .port.readHealthCounts(SCOPE)).homeRenderBytes, 1_000_000, "exactly at the ceiling is allowed");
});

test("the web port refuses when the web login has lost the approval INSERT", async () => {
  await assert.rejects(webPort({ privilege: { hasPlanApprovalInsert: async () => false } })
    .port.readHealthCounts(SCOPE), /^Error: updater_health_web_reads_refused:plan_approval_insert/u);
});

test("the web port refuses a missing scope, and an incomplete composition", async () => {
  for (const scope of [undefined, null, {}, { tenantId: "", workspaceId: SCOPE.workspaceId },
    { tenantId: SCOPE.tenantId, workspaceId: 0 }] as never[])
    await assert.rejects(webPort().port.readHealthCounts(scope),
      /^Error: updater_health_web_reads_refused:scope/u);
  for (const incomplete of [{ reads: undefined }, { home: undefined }, { privilege: undefined }] as never[])
    assert.throws(() => webPort(incomplete), /^Error: updater_health_web_reads_refused:composition/u,
      "a composition missing any whole input must be refused at construction");
});

test("the web port survives 50 concurrent callers and answers them identically", async () => {
  const { port } = webPort();
  const results = await Promise.all(Array.from({ length: 50 }, () => port.readHealthCounts(SCOPE)));
  const expected = JSON.stringify(results[0]);
  for (const [index, result] of results.entries())
    assert.equal(JSON.stringify(result), expected, `caller ${index} saw a different answer`);
});