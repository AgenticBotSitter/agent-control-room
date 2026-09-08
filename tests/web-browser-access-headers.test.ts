import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createIdeaBrowserClient } from "../src/web/v1/idea-browser-client.ts";
import { createIdeaCreationClient } from "../src/web/v1/idea-create-client.ts";
import { createNewsArchiveClient } from "../src/web/v1/news-archive-client.ts";
import { createNewsSourceClient } from "../src/web/v1/news-source-client.ts";
import { createNewsRefreshClient } from "../src/web/v1/news-refresh-client.ts";
import { browserAuthenticationRecovery } from "../src/web/v1/browser-client.ts";

test("all private browser fetch call sites request explicit Access expiry responses", () => {
  const files = readdirSync("src/web/v1").filter(name => /client\.ts$/.test(name)).map(name => `src/web/v1/${name}`)
    .concat(readdirSync("private-app/app").filter(name => name.endsWith(".tsx")).map(name => `private-app/app/${name}`));
  let checked = 0;
  for (const path of files) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const property = (object: ts.ObjectLiteralExpression, key: string) => object.properties.find(p => ts.isPropertyAssignment(p)
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) as ts.PropertyAssignment | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["fetch", "fetcher", "transport"].includes(node.expression.text)) {
        checked++;
        const options = node.arguments[1];
        assert.ok(options && ts.isObjectLiteralExpression(options), `${path}: explicit request options`);
        const headers = property(options, "headers")?.initializer;
        assert.ok(headers && ts.isObjectLiteralExpression(headers), `${path}: explicit headers`);
        const header = property(headers, "x-requested-with")?.initializer;
        assert.ok(header && ts.isStringLiteral(header) && header.text === "XMLHttpRequest", `${path}: expired Access header`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked >= 24, `Expected current whole-client coverage; inspected ${checked}`);
});

test("an expired-session reply does not discard an earlier uncertain Idea save", async () => {
  const calls: { body: string; key: string }[] = [];
  const client = createIdeaCreationClient((async (_, init) => {
    assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
    calls.push({ body: String(init?.body), key: new Headers(init?.headers).get("idempotency-key")! });
    if (calls.length === 1) throw new Error("lost response");
    return new Response(null, { status: 401 });
  }) as typeof fetch, () => "expired-idea-save-0001");
  const draft = { title: "Shop assistant", ideaSummary: "Help shops answer questions.", targetCustomer: "Small retailers",
    maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };
  await assert.rejects(client.create(draft), /uncertain/);
  await assert.rejects(client.retry(), /authentication_required/);
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.create({ ...draft, title: "Different idea" }), /uncertain/);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});

test("news actions distinguish an initial login denial from an unresolved earlier save", async () => {
  for (const kind of ["archive", "source", "refresh"] as const) for (const lost of [false, true]) {
    const bodies: string[] = [];
    const transport: typeof fetch = async (_, init) => {
      assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
      bodies.push(String(init?.body));
      if (lost && bodies.length === 1) throw new Error("lost response");
      return new Response(null, { status: 401 });
    };
    const archive = createNewsArchiveClient("project:news", transport);
    const source = createNewsSourceClient(transport);
    const refresh = createNewsRefreshClient("project:news", "source:news", transport);
    const client = kind === "archive" ? archive : kind === "source" ? source : refresh;
    const send = () => kind === "archive" ? archive.save({ storyId: "story:news", archived: true, expectedRevision: 0 })
      : kind === "source" ? source.save("project:news", { source: { id: "source:news", name: "News", url: "https://example.invalid/feed", enabled: true }, expectedRevision: 0 })
      : refresh.propose({ projectId: "project:news", sourceId: "source:news", configured: true, canRefresh: true, startsWork: false,
        sourceDigest: `sha256:${"a".repeat(64)}`, sourceLabel: "News", endpointUrl: "https://example.invalid/feed", mode: "feed",
        sourceCurrent: true, allowedOrigins: ["https://example.invalid"], limits: { timeoutMs: 1000, maxAttempts: 1, maxDocumentBytes: 1000, maxReservedBodyBytes: 1000 } }, "news-expiry-test-001");
    await assert.rejects(send());
    if (lost) await assert.rejects(client.retry(), /sign-in has expired.*still unconfirmed/);
    assert.equal(client.hasPending(), lost, kind);
    if (lost) assert.deepEqual(bodies, [bodies[0], bodies[0]]);
    else assert.equal(bodies.length, 1);
  }
});

test("expired Idea reads request private response semantics and expose authentication-required without retry", async () => {
  let calls = 0;
  const client = createIdeaBrowserClient((async (_, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
    assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    return new Response("private edge content must not be surfaced", { status: 401 });
  }) as typeof fetch);
  await assert.rejects(client.list(), /^Error: authentication_required$/);
  await assert.rejects(client.detail("idea:example"), /^Error: authentication_required$/);
  assert.equal(calls, 2);
  assert.match(browserAuthenticationRecovery(true), /Keep this tab open.*another tab.*still unconfirmed.*exact save/);
  assert.doesNotMatch(browserAuthenticationRecovery(true), /was not saved|reload this tab/);
});
