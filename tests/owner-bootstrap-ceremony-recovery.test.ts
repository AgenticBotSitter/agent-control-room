import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { origin } from "./helpers/web-foundation";
import { nodeExchange } from "./helpers/web-node";
import { prepared, syntheticLifecycle } from "./owner-bootstrap-ceremony-helper";

test("lost commit acknowledgement is terminal, and restart observes the created owner", async t => {
  let lose = true;
  const x = await prepared(base => ({ query: base.query.bind(base), transaction: base.transaction.bind(base),
    transactionWithPreCommitCheck: async (work, check) => {
      const result = await base.transactionWithPreCommitCheck(work, check);
      if (lose) { lose = false; throw new Error("synthetic_commit_ack_lost"); } return result;
    } }));
  t.after(() => x.raw.close()); await x.ceremony.arm(x.attempt());
  assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
  assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "1");
  assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
  const existing = await prepared(undefined, syntheticLifecycle(), { existingOwner: true }); t.after(() => existing.raw.close());
  const node = createPrivateNodeHandler({ origin, application: { isReady: () => true, async close() {} },
    handler: () => new Response("normal"), assets: { count: 0, digest: "empty", respond: () => undefined },
    ownerBootstrapCeremony: existing.ceremony });
  const exchange = nodeExchange(); await node.handle(exchange.input, exchange.output);
  assert.equal(exchange.output.statusCode, 200); assert.equal(exchange.body(), "normal");
  await assert.rejects(existing.ceremony.arm(existing.attempt()), /unavailable/);

  const marker = syntheticLifecycle(); let replacements = 0;
  const crashed = await prepared(undefined, marker); t.after(() => crashed.raw.close());
  await crashed.ceremony.arm(crashed.attempt());
  const recovered = await prepared(undefined, marker); t.after(() => recovered.raw.close());
  await assert.rejects(recovered.ceremony.arm(recovered.attempt({ async writeCode() { replacements++; } })), /unavailable/);
  assert.equal(replacements, 0);
});
