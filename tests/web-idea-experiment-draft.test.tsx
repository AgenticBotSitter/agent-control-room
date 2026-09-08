import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { origin, token } from "./helpers/web-foundation";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createIdeaBrowserClient } from "../src/web/v1/idea-browser-client";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { canPrepareIdeaExperiment, prepareIdeaExperimentDraft } from "../src/web/v1/idea-experiment-draft";
import { TaskProposalForm } from "../private-app/app/task-panels";

test("promoted Idea experiment becomes an editable ordinary task through restricted mounted routes", async t => {
  const f = await limitedWebFixture();
  const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: f.clock });
  t.after(() => app.close());
  let writes = 0, drop = false, authenticated = true;
  const bodies: string[] = [], keys: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("origin", origin);
    if (authenticated) headers.set("cf-access-jwt-assertion", token());
    if (init?.method === "POST") { writes++; bodies.push(String(init.body)); keys.push(headers.get("idempotency-key")!); }
    const response = await app.handle(new Request(new URL(String(url), origin), { ...init, headers }), () => new Response("shell"));
    if (drop && init?.method === "POST") { drop = false; throw new Error("lost response after commit"); }
    return response;
  };
  const ideas = createIdeaBrowserClient(transport), tasks = createTaskBrowserClient(transport, () => "experiment-save-001");
  const page = await tasks.list("project.idea:web");
  assert.equal(canPrepareIdeaExperiment(page), true); assert.equal(page.tasks.length, 0);
  const detail = await ideas.detail(page.project.sourceIdeaSessionId!);
  const draft = await prepareIdeaExperimentDraft(page, id => ideas.detail(id));
  assert.equal(writes, 0);
  for (const expected of [detail.synthesis!.nextExperiment, detail.synthesis!.executiveSummary,
    detail.session.sessionId, detail.session.sessionDigest, detail.synthesis!.synthesisDigest, page.project.projectId])
    assert.ok(draft.instructions.includes(expected), expected);
  assert.match(draft.instructions, /synthetic test contributions/);
  assert.match(draft.instructions, /untrusted advice/);
  assert.match(draft.instructions, /Do not execute the experiment/);
  const html = renderToStaticMarkup(<TaskProposalForm draft={draft} setDraft={() => {}} pending={false}
    uncertain={false} onSave={() => {}} />);
  assert.ok(html.includes("Save proposal")); assert.ok(html.includes("Session digest:"));
  const preparing = renderToStaticMarkup(<TaskProposalForm draft={draft} setDraft={() => {}} pending={false}
    preparing uncertain={false} onSave={() => {}} />);
  assert.equal((preparing.match(/disabled=""/g) ?? []).length, 3);
  assert.ok(preparing.includes("Reading experiment…")); assert.ok(!preparing.includes("Saving proposal…"));

  await t.test("missing permission metadata or mismatched provenance cannot prepare a task", async () => {
    for (const value of [{ ...page, canPropose: false }, { ...page, project: { ...page.project, lifecycle: "paused" as const } },
      { ...page, project: { ...page.project, sourceIdeaSessionId: undefined } }]) {
      assert.equal(canPrepareIdeaExperiment(value), false);
      await assert.rejects(prepareIdeaExperimentDraft(value, async () => { throw new Error("must not read"); }), /access_denied/);
    }
    await assert.rejects(prepareIdeaExperimentDraft(page, async () => ({ ...detail,
      decision: { ...detail.decision!, project: { projectId: "project:unrelated" } } })), /conflict/);
    await assert.rejects(prepareIdeaExperimentDraft(page, async () => ({ ...detail,
      synthesis: { ...detail.synthesis!, sessionDigest: "sha256:" + "0".repeat(64) } })));
    const long = { ...detail, synthesis: { ...detail.synthesis!, executiveSummary: "x".repeat(2001) } };
    await assert.rejects(prepareIdeaExperimentDraft(page, async () => long));
    authenticated = false;
    await assert.rejects(prepareIdeaExperimentDraft(page, id => ideas.detail(id)), /authentication_required/);
    authenticated = true; assert.equal(writes, 0);
  });

  const edited = { ...draft, title: "Plan our first experiment" };
  drop = true;
  await assert.rejects(tasks.propose(page.project.projectId, edited), /uncertain/);
  assert.equal(tasks.hasPending(), true);
  const receipt = await tasks.retrySave();
  assert.equal(receipt.startsWork, false); assert.equal(receipt.projectId, page.project.projectId);
  assert.equal(tasks.hasPending(), false);
  assert.equal(writes, 2); assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]);
  const saved = await tasks.detail(page.project.projectId, receipt.jobId);
  assert.equal(saved.instructions, edited.instructions); assert.equal(saved.task.title, edited.title);
  assert.equal(saved.task.state, "proposed"); assert.equal(saved.attempts.length, 0);
  assert.equal((await tasks.list(page.project.projectId)).tasks.length, 1);
});
