// M6/review B1: the browser client's own refusal-reason plumbing. The upload panel's tests
// (module-bundle-transfer-ui.test.tsx) drive it through a fake client shape and never exercise
// this file's `call()`, so this is the only place the reason-carrying logic itself is checked.
import assert from "node:assert/strict";
import test from "node:test";
import { createModuleTransferBrowserClient } from "../src/web/v1/module-transfer-browser-client.ts";
import { BrowserRequestError } from "../src/web/v1/browser-client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("preview carries the server's exact refusal reason through a 400", async () => {
  const transport = (async () => jsonResponse(400, { error: "invalid_request", reason: "module_signature_digest_mismatch" })) as typeof fetch;
  const client = createModuleTransferBrowserClient(transport);
  await assert.rejects(client.preview({ bundle: {} }), (error: unknown) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, "module_signature_digest_mismatch");
    return true;
  });
});

test("approve also carries the reason through a 400", async () => {
  const transport = (async () => jsonResponse(400, { error: "invalid_request", reason: "module_bundle_code_source_untrusted" })) as typeof fetch;
  const client = createModuleTransferBrowserClient(transport);
  await assert.rejects(client.approve({ bundle: {} }, {}, "test-key-0000000000000000"), (error: unknown) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, "module_bundle_code_source_untrusted");
    return true;
  });
});

test("a 400 with no reason field leaves reason undefined, not a crash", async () => {
  const transport = (async () => jsonResponse(400, { error: "invalid_request" })) as typeof fetch;
  const client = createModuleTransferBrowserClient(transport);
  await assert.rejects(client.preview({ bundle: {} }), (error: unknown) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, undefined);
    return true;
  });
});

test("a non-400 failure never carries a reason, even if the body has one", async () => {
  const transport = (async () => jsonResponse(503, { error: "service_unavailable", reason: "should_be_ignored" })) as typeof fetch;
  const client = createModuleTransferBrowserClient(transport);
  await assert.rejects(client.approve({ bundle: {} }, {}, "test-key-0000000000000000"), (error: unknown) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.reason, undefined);
    return true;
  });
});

test("an unreadable body on a 400 still refuses cleanly with no reason", async () => {
  const transport = (async () => new Response("not json", { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
  const client = createModuleTransferBrowserClient(transport);
  await assert.rejects(client.preview({ bundle: {} }), (error: unknown) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, undefined);
    return true;
  });
});
