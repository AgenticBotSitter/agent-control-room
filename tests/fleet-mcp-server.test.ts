import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as connector from "../scripts/fleet/connector.mjs";

const OFFER = `fleet-offer:${"a".repeat(32)}`;
const CLAIM = `fleet-claim:${"b".repeat(32)}`;
const PROJECT = "project:mcp-test";

function message(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function resultValue(reply: any) {
  return JSON.parse(reply.result.content[0].text);
}

function dispatcher(client: Record<string, unknown>, workspaceRoot: string): (request: unknown) => Promise<any> {
  const dispatch = connector.createMcpDispatcher({ client, workspaceRoot });
  return request => dispatch(request) as Promise<any>;
}

function fakeClient(overrides: Record<string, (...args: any[]) => unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const invoke = (name: string, value: unknown) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return value;
  };
  const client = {
    mcpCall: invoke("audit", { recorded: true }),
    work: invoke("work", [{ offerId: OFFER, projectId: PROJECT }]),
    claim: invoke("claim", { claimId: CLAIM, replayed: false }),
    progress: invoke("progress", { eventId: "fleet-event:progress", replayed: false }),
    result: invoke("result", { resultId: "fleet-result:result", accepted: false }),
    blocker: invoke("blocker", { eventId: "fleet-event:blocker", released: true }),
    propose: invoke("propose", { state: "proposed", startsWork: false }),
    ...overrides,
  };
  return { client, calls };
}

test("MCP protocol delegates each of the six tools and audits every call first", async t => {
  const root = await mkdtemp(join(tmpdir(), "fleet-mcp-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "answer.md"), "done\n");
  const f = fakeClient();
  const dispatch = dispatcher(f.client, root);
  const calls = [
    ["list_eligible_work", {}],
    ["claim", { offerId: OFFER }],
    ["post_progress", { claimId: CLAIM, message: "working" }],
    ["submit_result", { claimId: CLAIM, answer: "done", files: ["answer.md"] }],
    ["report_blocker", { claimId: CLAIM, message: "blocked", release: true }],
    ["propose_work", { projectId: PROJECT, proposal: { schema: "control-room.work-batch-proposal/v1" } }],
  ] as const;
  for (const [index, [name, args]] of calls.entries()) {
    const reply = await dispatch(message(index + 1, name, args));
    assert.equal(reply.result.isError, undefined, name);
  }
  assert.deepEqual(f.calls.map(call => call[0]), ["audit", "work", "audit", "claim", "audit", "progress",
    "audit", "result", "audit", "blocker", "audit", "propose"]);
  assert.deepEqual(f.calls.filter(call => call[0] === "audit").map(call => call[2]), calls.map(call => call[0]));
});

test("MCP claim retries use one deterministic idempotency key", async () => {
  const f = fakeClient();
  const dispatch = dispatcher(f.client, process.cwd());
  await dispatch(message(1, "claim", { offerId: OFFER }));
  await dispatch(message(2, "claim", { offerId: OFFER }));
  const claims = f.calls.filter(call => call[0] === "claim");
  assert.equal(claims.length, 2);
  assert.match(String(claims[0]![2]), /^mcp-[a-f0-9]{40}$/u);
  assert.equal(claims[0]![2], claims[1]![2]);
});

test("MCP exposes no approval, acceptance, merge, grant, review or permission-widening tool", async () => {
  const f = fakeClient();
  const dispatch = dispatcher(f.client, process.cwd());
  const listed = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name),
    ["list_eligible_work", "claim", "post_progress", "submit_result", "report_blocker", "propose_work"]);
  for (const [index, name] of ["approve", "accept", "merge", "grant", "widen_permissions", "review"].entries()) {
    const reply = await dispatch(message(index + 2, name, {}));
    assert.equal(reply.error.code, -32602);
  }
  assert.equal(f.calls.filter(call => call[0] === "audit").length, 6, "forbidden attempts are audited too");
  assert.ok(f.calls.filter(call => call[0] === "audit").every(call => call[2] === "unsupported"));
});

test("MCP rejects malformed and oversized inputs after auditing and before an operation", async () => {
  const f = fakeClient();
  const dispatch = dispatcher(f.client, process.cwd());
  const invalid = [
    ["claim", { offerId: "fleet-offer:short", approve: true }],
    ["post_progress", { claimId: CLAIM, message: "x".repeat(2001) }],
    ["submit_result", { claimId: CLAIM, answer: "é".repeat(32_769) }],
    ["submit_result", { claimId: CLAIM, answer: "done", files: Array(9).fill("a.txt") }],
    ["report_blocker", { claimId: CLAIM, message: "blocked", release: "yes" }],
    ["propose_work", { projectId: PROJECT, proposal: { text: "x".repeat(256 * 1024) } }],
  ] as const;
  for (const [index, [name, args]] of invalid.entries()) {
    const reply = await dispatch(message(index + 1, name, args));
    assert.equal(reply.result.isError, true, name);
    assert.equal(reply.result.content[0].text, "The arguments do not match this tool.");
  }
  assert.deepEqual(f.calls.map(call => call[0]), Array(invalid.length).fill("audit"));
});

test("MCP surfaces revoked, expired, cross-project and cross-tenant refusals without widening scope", async () => {
  for (const state of ["revoked", "expired"]) {
    const f = fakeClient({ mcpCall: async () => { throw new Error("Control Room refused the request (unauthenticated)."); } });
    const dispatch = dispatcher(f.client, process.cwd());
    const reply = await dispatch(message(1, "list_eligible_work", {}));
    assert.equal(reply.result.isError, true, state);
    assert.match(reply.result.content[0].text, /unauthenticated/u);
    assert.ok(!f.calls.some(call => call[0] === "work"));
  }
  for (const scope of ["cross-project", "cross-tenant"]) {
    const f = fakeClient({ propose: async () => { throw new Error("Control Room refused the request (not_found)."); } });
    const dispatch = dispatcher(f.client, process.cwd());
    const reply = await dispatch(message(1, "propose_work", { projectId: PROJECT,
      proposal: { schema: "control-room.work-batch-proposal/v1" } }));
    assert.equal(reply.result.isError, true, scope);
    assert.match(reply.result.content[0].text, /not_found/u);
  }
});

test("MCP result files cannot traverse or escape through a symbolic link", async t => {
  const parent = await mkdtemp(join(tmpdir(), "fleet-mcp-files-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  await mkdir(root);
  await writeFile(join(parent, "outside.txt"), "private\n");
  await symlink(join(parent, "outside.txt"), join(root, "link.txt"));
  const f = fakeClient();
  const dispatch = dispatcher(f.client, root);
  for (const path of ["../outside.txt", "link.txt"]) {
    const reply = await dispatch(message(1, "submit_result", { claimId: CLAIM, answer: "done", files: [path] }));
    assert.equal(reply.result.isError, true);
  }
  assert.ok(!f.calls.some(call => call[0] === "result"));
});

test("stdio MCP returns protocol errors for malformed and oversized JSON-RPC messages", async t => {
  const root = await mkdtemp(join(tmpdir(), "fleet-mcp-wire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "connector.json");
  await writeFile(configPath, JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: `fleet-worker:${"c".repeat(32)}`, secret: `crf_${"A".repeat(43)}`, credentialExpiresAt: "2099-01-01T00:00:00.000Z" }),
  { mode: 0o600 });
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk; });
  const serving = connector.serveMcp({ configPath, input, output, workspaceRoot: root });
  input.write("{not json}\n");
  input.write(`${"x".repeat(512 * 1024 + 1)}\n`);
  input.end();
  await serving;
  const replies = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.error.code), [-32700, -32600]);
});
