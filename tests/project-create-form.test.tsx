import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCreateForm, validateProjectDraft } from "../app/components/project-create-form.tsx";

test("project draft validation matches the frozen title and summary boundaries", () => {
  assert.deepEqual(validateProjectDraft({ title: " Work ", summary: " Short " }), { ok: true, draft: { title: "Work", summary: "Short" } });
  for (const value of [{ title: " ", summary: "" }, { title: "x".repeat(121), summary: "" }, { title: "x", summary: "x".repeat(1001) }])
    assert.equal(validateProjectDraft(value).ok, false);
  assert.equal(validateProjectDraft({ title: "x".repeat(120), summary: "x".repeat(1000) }).ok, true);
});
test("form labels and pending/result states do not imply a callback saved a project", () => {
  const render = (pending: boolean, result: "idle" | "created" | "invalid" | "unavailable") =>
    renderToStaticMarkup(<ProjectCreateForm pending={pending} result={result} onCreate={() => { throw new Error(); }} />);
  assert.match(render(true, "idle"), /disabled=""/); assert.match(render(false, "idle"), /for="project-title"/);
  assert.doesNotMatch(render(false, "idle"), /Project saved/); assert.match(render(false, "created"), /Project saved/);
  assert.match(render(false, "invalid"), /role="alert"/); assert.match(render(false, "unavailable"), /could not be confirmed/);
});
