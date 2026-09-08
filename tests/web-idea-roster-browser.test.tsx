import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createIdeaCreationClient } from "../src/web/v1/idea-create-client";
import { IdeaRosterSelection, ideaRosterSelectionValid } from "../private-app/app/idea-create-form";
import type { IdeaCreationOptions } from "../src/web/v1/idea-wire";

const options: IdeaCreationOptions = { startsWork: false, minParticipants: 3, maxParticipants: 6, requiredPerspectives: ["skeptic"],
  participants: ["skeptic", "researcher", "builder", "customer"].map((perspective, i) => ({ participantId: `bot:${i}`,
    participantDigest: `sha256:${String(i + 1).repeat(64)}`, displayName: `Bot ${i}`, perspective, harness: "hermes" })) };
const draft = { title: "Idea", ideaSummary: "Help shops", targetCustomer: "Shops", maxRounds: 1, maxDurationSeconds: 300, maxCostUsd: 2,
  participantSelections: options.participants.slice(0, 3).map(({ participantId, participantDigest }) => ({ participantId, participantDigest })) };

test("roster options are private reads and denial cannot replace an uncertain selected roster", async () => {
  let deny = false; const bodies: string[] = [], keys: string[] = [];
  const client = createIdeaCreationClient(async (path, init) => {
    assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
    if (init?.method === "POST") { bodies.push(String(init.body)); keys.push(new Headers(init.headers).get("idempotency-key")!); throw new Error("lost response"); }
    assert.equal(path, "/api/v1/ideas/options");
    return Response.json(options, { status: deny ? 401 : 200 });
  }, () => "idea-roster-test-key");
  assert.deepEqual(await client.options(), options); assert.equal(bodies.length, 0);
  await assert.rejects(client.create(draft), /uncertain/); deny = true;
  await assert.rejects(client.options(), /authentication_required/); assert.equal(client.hasPending(), true);
  await assert.rejects(client.create({ ...draft, participantSelections: options.participants.slice(1).map(({ participantId, participantDigest }) => ({ participantId, participantDigest })) }), /uncertain/);
  await assert.rejects(client.retry(), /uncertain/);
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]);
});

test("options reject duplicate, missing-skeptic and unexpected descriptors with safe errors", async () => {
  let body: unknown = options;
  const client = createIdeaCreationClient(async () => Response.json(body));
  for (const invalid of [{ ...options, participants: [options.participants[0], options.participants[0], options.participants[2]] },
    { ...options, participants: options.participants.slice(1) }, { ...options, privateKey: "not-a-real-key" },
    { ...options, participants: options.participants.map(p => ({ ...p, identityDigest: p.participantDigest })) }]) {
    body = invalid; await assert.rejects(client.options(), /unavailable/);
  }
});

test("roster chooser shows configured descriptors and enforces size, identity and skeptic before saving", () => {
  const selected = options.participants.slice(0, 3).map(p => p.participantId);
  assert.equal(ideaRosterSelectionValid(options, selected), true);
  for (const invalid of [selected.slice(0, 2), options.participants.slice(1).map(p => p.participantId),
    [selected[0], selected[0], selected[2]], [selected[0], selected[1], "bot:forged"]]) assert.equal(ideaRosterSelectionValid(options, invalid), false);
  let changes = 0;
  const html = renderToStaticMarkup(<IdeaRosterSelection options={options} selected={selected} disabled change={() => { changes++; }} />);
  for (const p of options.participants) { assert.ok(html.includes(p.displayName)); assert.ok(html.includes(p.perspective)); }
  assert.match(html, /does not confirm|do not confirm/); assert.match(html, /must include a skeptic/);
  assert.match(html, /fieldset disabled/); assert.equal((html.match(/checked=""/g) ?? []).length, 3); assert.equal(changes, 0);
  for (const p of options.participants) assert.ok(!html.includes(p.participantDigest));
});
