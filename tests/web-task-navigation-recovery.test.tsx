import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskAuthenticationRecovery } from "../private-app/app/task-workspace";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { installNewsNavigationGuard } from "../src/web/v1/news-navigation-guard";

test("task authentication recovery preserves the current tab instead of linking to destructive logout", () => {
  for (const held of [false, true]) {
    const html = renderToStaticMarkup(<TaskAuthenticationRecovery held={held} />);
    assert.match(html, /Keep this tab open/); assert.match(html, /another tab/);
    assert.doesNotMatch(html, /<a|href=|access\/logout/);
    if (held) assert.match(html, /exact save again, without changing the request/);
  }
});

test("lost task save stays guarded through expired authentication and retries exact bytes after recovery", async () => {
  const bodies: string[] = [], keys: string[] = [];
  let phase: "lost" | "expired" | "recovered" = "lost";
  const client = createTaskBrowserClient(async (_url, init) => {
    bodies.push(String(init?.body)); keys.push(new Headers(init?.headers).get("idempotency-key")!);
    if (phase === "lost") throw new Error("synthetic lost acknowledgement");
    if (phase === "expired") return Response.json({}, { status: 401 });
    return Response.json({ receipt: { projectId: "project:one", jobId: "job:one", requestId: "request:one",
      createdAt: "2026-09-08T07:30:00.000Z", submission: "proposed", startsWork: false }, replayed: true });
  }, () => "task-navigation-recovery-001");
  const documentPort = new EventTarget(), windowPort = new EventTarget(); let explanations = 0;
  const cleanup = installNewsNavigationGuard(windowPort as unknown as Window, documentPort as unknown as Document,
    client.hasPending, () => { explanations++; });
  const click = () => {
    const event = new Event("click", { cancelable: true });
    Object.defineProperty(event, "target", { value: { closest: () => ({ href: "/projects" }) } });
    documentPort.dispatchEvent(event); return event.defaultPrevented;
  };
  try {
    assert.equal(click(), false);
    await assert.rejects(client.propose("project:one", { title: "Research this article", instructions: "Verify the primary sources." }));
    assert.equal(click(), true);
    phase = "expired"; await assert.rejects(client.retrySave(), { code: "authentication_required" });
    assert.equal(client.hasPending(), true); assert.equal(click(), true);
    const leave = new Event("beforeunload", { cancelable: true });
    Object.defineProperty(leave, "returnValue", { value: undefined, writable: true });
    windowPort.dispatchEvent(leave); assert.equal(leave.defaultPrevented, true);
    phase = "recovered"; const receipt = await client.retrySave();
    assert.equal(receipt.startsWork, false); assert.equal(client.hasPending(), false); assert.equal(click(), false);
    assert.equal(new Set(bodies).size, 1); assert.equal(new Set(keys).size, 1); assert.equal(explanations, 2);
  } finally { cleanup(); }
  assert.equal(click(), false);
});
