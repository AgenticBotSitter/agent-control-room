import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletionGatePanel } from "../app/components/completion-gate-panel";
import { cr8cCompletionGateFixture } from "../app/fixtures/cr8c-ui";

test("CR8C Completion Gate UI shows evidence and never supplies an action control", () => {
  const html = renderToStaticMarkup(<CompletionGatePanel items={cr8cCompletionGateFixture} />);
  assert.match(html, /This panel shows review evidence only/);
  assert.match(html, /Changes requested/);
  assert.match(html, /Quality review complete/);
  assert.match(html, /Separate operation approval/);
  assert.match(html, /Still needed: Scenario Audio Qc/);
  assert.match(html, /Preference Recorded/);
  assert.match(html, /separate node attestation required/);
  assert.match(html, /Raw content stays protected/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /memory:\/\/|private key|credential:|Bearer /i);
});

test("CR8C Completion Gate UI has an explicit scoped empty state", () => {
  const html = renderToStaticMarkup(<CompletionGatePanel items={[]} />);
  assert.match(html, /No Completion Gate targets are visible in this scope/);
});

test("CR8C Completion Gate UI escapes hostile projected text", () => {
  const hostile = [{ ...cr8cCompletionGateFixture[0], target: { ...cr8cCompletionGateFixture[0].target, subjectLabel: "<script>unsafe()</script>" } }];
  const html = renderToStaticMarkup(<CompletionGatePanel items={hostile} />);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe/);
});
