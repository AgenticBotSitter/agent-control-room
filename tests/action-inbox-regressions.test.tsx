import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { mounted, button } from "./support/owner-notify-fixtures";
import { supervisorItem } from "./support/r6-inbox-fixtures";
import { PrivateHeader } from "../private-app/app/private-header";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { PrivateActionInbox, ActionInboxPanel } from "../private-app/app/needs-me/action-inbox";
import { HomeDashboard } from "../private-app/app/home-workspace";
import { taskAttentionPageSchema } from "../src/web/v1/task-attention-wire";
import { readAllTaskAttention, retainTaskAttentionPages } from "../src/web/v1/task-attention-source";
import { buildActionInbox } from "../src/web/v1/action-inbox";
import { workBatchOwnerNotificationV1 } from "../src/work-intake/v1/owner-notification";

const now = "2026-10-02T12:00:00.000Z";
const task = (n: number, state = "waiting_approval", reasons = ["approval"]) => ({
  task: { projectId: "project:fixture", jobId: `job:${String(n).padStart(4, "0")}`, requestId: `request:${n}`,
    title: `Attention ${n}`, state, version: 1, createdAt: now, updatedAt: now },
  inputDigest: `sha256:${"a".repeat(64)}`, reasons,
});
const page = (items: any[] = [], nextCursor: string | null = null, examined = items.length) => taskAttentionPageSchema.parse({
  items, nextCursor, examined, observedAt: now, startsWork: false, planningSource: "configured",
  deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" },
});
const source = (items: any[] = [], truncated = false) => ({ observedAt: now, items, truncated });
const batch = workBatchOwnerNotificationV1({ tenantId: "tenant:fixture", projectId: "project:fixture",
  batchId: "batch:fixture", createdAt: now }).item;
const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
const Wrapped = ({ mode = "local" }: any) => h(LocalRuntimeContextV1.Provider, { value: { mode } },
  h(React.Fragment, null, h(PrivateHeader), h(PrivateActionInbox)));

test("R6I-01: canonical batch approvals lead the shared top attention box in both runtime modes", { timeout: 15000 }, async () => {
  for (const mode of ["local", "hosted"]) await mounted(() => h(Wrapped, { mode }), async (path: any) =>
    Response.json(String(path).includes("action-items") ? source([batch]) : page()), {}, async dom => {
    await wait();
    const top = dom.window.document.querySelector('[aria-label="Needs attention"]')!;
    assert.match(top.textContent!, /Review proposed work batch/);
    assert.doesNotMatch(top.textContent!, /All clear/);
    assert.match(top.querySelector(".private-nav-badge")!.textContent!, /^1/);
    assert.equal(top.querySelector("a[href*='/pipelines/']")?.getAttribute("href"), "/projects/project%3Afixture/pipelines/batch%3Afixture");
  });
});

test("R6I-02: empty candidate pages cannot hide a later approval in the top box or Home", { timeout: 15000 }, async () => {
  const first = page([], "job:0024", 25), second = page([task(25)]);
  await mounted(Wrapped, async (path: any) => Response.json(String(path).includes("action-items") ? source()
    : String(path).includes("after=") ? second : first), {}, async dom => {
    await wait();
    const top = dom.window.document.querySelector('[aria-label="Needs attention"]')!;
    assert.match(top.textContent!, /Attention 25/);
    assert.doesNotMatch(top.textContent!, /All clear/);
  });
  const html = renderToStaticMarkup(h(HomeDashboard, { data: { projects: { state: "unavailable" }, activity: { state: "unavailable" },
    attention: { state: "ready", value: first }, connections: { state: "ready", value: { source: "local", value: { taskWorkersStarted: true, projectSections: [], workers: [] } } } } } as any));
  const home = new JSDOM(html);
  try {
    const top = home.window.document.querySelector('[aria-labelledby="home-attention"]')!;
    assert.doesNotMatch(top.textContent!, /All clear/);
    assert.match(top.textContent!, /Checking|could not be checked/);
  } finally { home.window.close(); }
});

test("R6I-03: saved producer records link to their exact batch and single supervisor task", async () => {
  const warning = await supervisorItem();
  const rows = buildActionInbox([], [batch, warning]);
  assert.equal(rows.find(row => row.title === batch.requestedAction)?.href, "/projects/project%3Afixture/pipelines/batch%3Afixture");
  assert.equal(rows.find(row => row.title === warning.requestedAction)?.href, "/projects/project%3Afixture/tasks/job%3A0000");
  assert.equal(buildActionInbox([], [{ ...warning, blockedWorkItemIds: ["job:a", "job:b"] }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...warning, id: "attention:unrelated" }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...warning, reasonCode: "unrelated_reason" }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...warning, projectId: undefined }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...batch, workItemId: undefined }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...batch, reasonCode: "other_approval" }])[0].href, undefined);
  assert.equal(buildActionInbox([], [{ ...warning, workItemId: "job:unrelated", id: "attention:other" }])[0].href, undefined);
});

test("R6I-04: 50 stalled tasks each retain one card with warning evidence, responses and delivery", async () => {
  const warnings = await Promise.all(Array.from({ length: 50 }, (_, n) => supervisorItem(n)));
  const tasks = Array.from({ length: 50 }, (_, n) => task(n, "orphaned", ["orphaned"]));
  const pages = [page(tasks.slice(0, 25), "job:0024"), page(tasks.slice(25))];
  const rows = buildActionInbox(pages, warnings);
  assert.equal(rows.length, 50);
  for (const row of rows) {
    assert.ok(row.href); assert.equal(row.evidenceCount, 1);
    assert.ok(row.availableResponses.includes("Review recorded task evidence"));
    assert.equal(row.deliveryState, "not_requested");
    assert.match(row.summary, /Inspect the recorded attempt/);
  }
  const unrelated = { ...warnings[0], id: "attention:other-decision", kind: "approval" as const };
  assert.equal(buildActionInbox(pages, [...warnings, unrelated]).length, 51);
});

test("R6I-05: failed refresh preserves known approvals, successful resolution removes them, auth loss clears them", { timeout: 15000 }, async () => {
  let status = 200, items = [batch];
  await mounted(PrivateActionInbox, async (path: any) => Response.json(String(path).includes("action-items") ? source(items) : page(), { status }), {}, async dom => {
    assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
    status = 503;
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
    assert.match(dom.window.document.body.textContent!, /couldn.t refresh/i);
    assert.doesNotMatch(dom.window.document.body.textContent!, /No actions are waiting/);
    status = 200; items = [];
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch/);
    items = [batch];
    await act(async () => button(dom, "Check Action Inbox again").click());
    status = 401;
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch/);
    assert.match(dom.window.document.body.textContent!, /session has ended/);
  });
});

test("R6 paging stress: 50 parallel readers retain all 251 items across eleven pages", { timeout: 15000 }, async () => {
  let calls = 0;
  const transport = async (path: any) => {
    calls++;
    const after = new URL(String(path), "https://control.invalid").searchParams.get("after");
    const start = after ? Number(after.slice(4)) + 1 : 0;
    const end = Math.min(start + 25, 251);
    await Promise.resolve();
    return Response.json(page(Array.from({ length: end - start }, (_, n) => task(start + n)), end < 251 ? `job:${String(end - 1).padStart(4, "0")}` : null));
  };
  const readers = await Promise.all(Array.from({ length: 50 }, () => readAllTaskAttention(transport)));
  assert.equal(calls, 550);
  for (const result of readers) {
    assert.equal(result.state, "available");
    if (result.state !== "available") throw new Error("source_failed");
    assert.equal(result.truncated, false); assert.equal(result.pages.length, 11);
    const rows = buildActionInbox(result.pages);
    assert.equal(rows.length, 251); assert.equal(new Set(rows.map(row => row.key)).size, 251);
    for (const n of [0, 24, 25, 49, 50, 249, 250]) assert.ok(rows.some(row => row.title === `Attention ${n}`));
  }
});

test("R6 paging safeguards: cap, bad data, repeated cursor, later-page failure and retry", { timeout: 15000 }, async () => {
  let calls = 0;
  const capped = await readAllTaskAttention(async (path: any) => {
    calls++;
    const after = new URL(String(path), "https://control.invalid").searchParams.get("after");
    const start = after ? Number(after.slice(4)) + 1 : 0;
    return Response.json(page([], `job:${String(start + 24).padStart(4, "0")}`, 25));
  });
  assert.equal(calls, 40); assert.equal(capped.state, "available");
  if (capped.state !== "available") throw new Error("source_failed");
  assert.equal(capped.truncated, true);
  const cappedHtml = renderToStaticMarkup(h(ActionInboxPanel, { data: { tasks: capped, operator: { state: "available", source: source() } } }));
  assert.match(cappedHtml, /safety limit/); assert.doesNotMatch(cappedHtml, /No actions are waiting/);
  for (const status of [503, 401, 403]) {
    const failed = await readAllTaskAttention(async (path: any) => String(path).includes("after=")
      ? new Response(null, { status }) : Response.json(page([task(0)], "job:0024", 25)));
    assert.equal(failed.state, "unavailable");
    if (failed.state !== "unavailable") throw new Error("unexpected_source");
    assert.equal(failed.pages.length, status === 503 ? 1 : 0);
  }
  const repeated = await readAllTaskAttention(async () => Response.json(page([], "job:0024", 25)));
  assert.equal(repeated.state, "unavailable");
  assert.equal((await readAllTaskAttention(async () => Response.json({ items: [] }))).state, "unavailable");
  assert.equal((await readAllTaskAttention(async () => Response.json(page([task(0)])))).state, "available");
});

test("R6 attention completeness: missing or truncated canonical source never allows all-clear, healthy empty sources do", { timeout: 15000 }, async () => {
  for (const canonicalReply of [() => new Response(null, { status: 503 }), () => Response.json(source([], true)), () => Response.json(source())]) {
    await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) => String(path).includes("action-items") ? canonicalReply() : Response.json(page()), {}, async dom => {
      await wait();
      const text = dom.window.document.querySelector('[aria-label="Needs attention"]')!.textContent!;
      if (canonicalReply().ok && !(await canonicalReply().json()).truncated) assert.match(text, /All clear/);
      else assert.doesNotMatch(text, /All clear/);
    });
  }
});

// int9: a connector-only installation has no Action Inbox source, and the route
// answers 404 there. That is not a failed check: the shared box must not raise a
// standing alert on every page, and complete task attention still allows the
// all-clear. A 503 from the same route stays a failure (the test above).
test("int9: an installation without an Action Inbox source shows task attention without a standing alert", { timeout: 15000 }, async () => {
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) =>
    String(path).includes("action-items") ? new Response(null, { status: 404 }) : Response.json(page()), {}, async dom => {
    await wait();
    const box = dom.window.document.querySelector('[aria-label="Needs attention"]')!;
    assert.match(box.textContent!, /All clear\./);
    assert.equal(box.querySelector('[role="alert"]'), null);
  });
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) =>
    String(path).includes("action-items") ? new Response(null, { status: 404 }) : Response.json(page([], "job:more")), {}, async dom => {
    await wait();
    assert.doesNotMatch(dom.window.document.querySelector('[aria-label="Needs attention"]')!.textContent!, /All clear\./,
      "incomplete task attention still refuses the all-clear");
  });
});

test("R6 stale task context survives later-page refresh failure and is cleared by task access loss", { timeout: 15000 }, async () => {
  let mode = "healthy";
  await mounted(PrivateActionInbox, async (path: any) => {
    if (String(path).includes("action-items")) return Response.json(source([batch]));
    if (mode === "denied") return new Response(null, { status: 403 });
    if (String(path).includes("after=")) return new Response(null, { status: 503 });
    return Response.json(mode === "healthy" ? page([task(0), task(1)]) : page([task(0)], "job:0024", 25));
  }, {}, async dom => {
    mode = "partial";
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.match(dom.window.document.body.textContent!, /Attention 0/);
    assert.match(dom.window.document.body.textContent!, /Attention 1/);
    assert.equal(dom.window.document.querySelectorAll("li").length, 3);
    mode = "denied";
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.doesNotMatch(dom.window.document.body.textContent!, /Attention 0|Attention 1|Review proposed work batch/);
  });
});

test("R6 stop halfway: aborting a reader prevents further candidate requests", { timeout: 15000 }, async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await readAllTaskAttention(async () => {
    calls++; controller.abort();
    return Response.json(page([], "job:0024", 25));
  }, controller.signal);
  assert.equal(calls, 1); assert.equal(result.state, "unavailable");
});

test("R6 shared summary retains known approval on failure, coalesces 50 focus events and resets on unmount", { timeout: 15000 }, async () => {
  let failed = false, calls = 0;
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(React.Fragment, null, ...Array.from({ length: 50 }, (_, n) => h(PrivateHeader, { key: n })))), async (path: any) => {
    calls++;
    return failed ? new Response(null, { status: 503 }) : Response.json(String(path).includes("action-items") ? source([batch]) : page());
  }, {}, async dom => {
    await wait(); assert.equal(calls, 2);
    failed = true;
    await act(async () => { for (let n = 0; n < 50; n++) dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(calls, 4);
    for (const top of dom.window.document.querySelectorAll('[aria-label="Needs attention"]')) {
      assert.match(top.textContent!, /Review proposed work batch/);
      assert.match(top.textContent!, /could not be checked/);
      assert.doesNotMatch(top.textContent!, /All clear/);
    }
  });
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) => Response.json(String(path).includes("action-items") ? source() : page()), {}, async dom => {
    await wait(); assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch/);
    assert.match(dom.window.document.body.textContent!, /All clear/);
  });
});

test("R6 merge preserves urgent rank and earliest expiry without merging another project", async () => {
  const warning = await supervisorItem();
  const warnings = [{ ...warning, expiresAt: "2026-10-04T12:00:00.000Z" }, { ...warning, id: "attention:supervisor:second", expiresAt: "2026-10-03T12:00:00.000Z" }];
  // r7iui classifies an item past its expiry as expired, so the merge is read at a
  // fixed instant before both fixture expiries rather than at the wall clock.
  const before = Date.parse("2026-10-02T00:00:00.000Z");
  const rows = buildActionInbox([page([task(0, "proposed", ["proposal"])])], warnings, before);
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, "blocked");
  assert.equal(rows[0].expiresAt, "2026-10-03T12:00:00.000Z");
  assert.equal(buildActionInbox([page([task(0)])], [{ ...warning, projectId: "project:other" }], before).length, 2);
});

test("R6 authorization loss clears known context before another source finishes", { timeout: 15000 }, async () => {
  for (const lostSource of ["tasks", "operator"]) {
    let denied = false, release: (value: Response) => void = () => {};
    await mounted(PrivateActionInbox, async (path: any) => {
      const operator = String(path).includes("action-items");
      if (!denied) return Response.json(operator ? source([batch]) : page());
      return operator === (lostSource === "operator") ? new Response(null, { status: 401 }) : new Promise<Response>(resolve => { release = resolve; });
    }, {}, async dom => {
      denied = true;
      try {
        await act(async () => button(dom, "Check Action Inbox again").click());
        assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch/);
        assert.match(dom.window.document.body.textContent!, /session has ended/);
      } finally { await act(async () => release(Response.json(lostSource === "operator" ? page() : source([batch])))); }
    });
  }
});

test("R6 shared summary removes cached protected context after either source loses authentication", { timeout: 15000 }, async () => {
  for (const lostSource of ["tasks", "operator"]) {
    let denied = false;
    await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) => {
      const operator = String(path).includes("action-items");
      return denied && (operator === (lostSource === "operator")) ? new Response(null, { status: 401 })
        : Response.json(operator ? source([batch]) : page([task(0)]));
    }, {}, async dom => {
      await wait(); denied = true;
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch|Attention 0/);
      assert.match(dom.window.document.body.textContent!, /could not be checked/);
    });
  }
});

test("R6 a pending recheck retains approval context but suppresses cached empty-inbox claims", { timeout: 15000 }, async () => {
  for (const items of [[], [batch]]) {
    let held = false;
    const replies: Array<() => void> = [];
    await mounted(Wrapped, async (path: any) => {
      const response = () => Response.json(String(path).includes("action-items") ? source(items) : page());
      return held ? new Promise<Response>(resolve => replies.push(() => resolve(response()))) : response();
    }, {}, async dom => {
      await wait(); held = true;
      try {
        await act(async () => {
          dom.window.dispatchEvent(new dom.window.Event("focus"));
          button(dom, "Check Action Inbox again").click();
        });
        assert.doesNotMatch(dom.window.document.body.textContent!, /All clear|No actions are waiting/);
        assert.match(dom.window.document.body.textContent!, /Checking saved attention/);
        if (items.length) assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
      } finally { await act(async () => replies.forEach(reply => reply())); }
    });
  }
});

test("R6 empty cached pages are discarded and fresh task rows replace old titles", () => {
  const previous = [page([task(0)]), page()];
  const fresh = [page([{ ...task(0), task: { ...task(0).task, title: "New title" } }])];
  const retained = retainTaskAttentionPages(previous, fresh);
  assert.equal(retained.length, 1);
  assert.equal(buildActionInbox(retained)[0].title, "New title");
});

test("R6 Home uses canonical rows, refuses incomplete all-clear and distinguishes checking", () => {
  for (const value of [{ items: buildActionInbox([], [batch]), complete: true }, { items: [], complete: false }, { items: [], complete: false, checking: true }]) {
    const html = renderToStaticMarkup(h(HomeDashboard, { data: { projects: { state: "unavailable" }, activity: { state: "unavailable" },
      attention: { state: "ready", value }, connections: { state: "ready", value: { source: "local", value: { taskWorkersStarted: true, projectSections: [], workers: [] } } } } } as any));
    const dom = new JSDOM(html);
    try {
      const top = dom.window.document.querySelector('[aria-labelledby="home-attention"]')!;
      assert.doesNotMatch(top.textContent!, /All clear/);
      if (value.items.length) {
        assert.match(top.textContent!, /Review proposed work batch/);
        assert.ok(top.querySelector("a[href*='/pipelines/']"));
      } else if ("checking" in value && value.checking) {
        assert.match(top.textContent!, /Checking/); assert.equal(top.querySelector('[role="alert"]'), null);
      } else assert.match(top.textContent!, /could not be checked/);
    } finally { dom.window.close(); }
  }
});

test("R6 canonical access loss removes only that source; incomplete task traversal retains cached context", { timeout: 15000 }, async () => {
  let mode = "healthy";
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) => {
    if (String(path).includes("action-items")) return mode === "denied" ? new Response(null, { status: 403 }) : Response.json(source([batch]));
    if (mode === "partial" && String(path).includes("after=")) return new Response(null, { status: 503 });
    return Response.json(mode === "partial" ? page([], "job:0024", 25) : page([task(0)]));
  }, {}, async dom => {
    await wait(); mode = "partial";
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(dom.window.document.body.textContent!, /Attention 0/);
    assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
    mode = "denied";
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(dom.window.document.body.textContent!, /Attention 0/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch|All clear/);
  });
});

test("R6 shared safety cap cannot claim all-clear and no protected cache crosses the last unmount", { timeout: 15000 }, async () => {
  const component = () => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader));
  await mounted(component, async (path: any) => {
    if (String(path).includes("action-items")) return Response.json(source());
    const after = new URL(String(path), "https://control.invalid").searchParams.get("after");
    const start = after ? Number(after.slice(4)) + 1 : 0;
    return Response.json(page([], `job:${String(start + 24).padStart(4, "0")}`, 25));
  }, {}, async dom => {
    await wait(); assert.doesNotMatch(dom.window.document.body.textContent!, /All clear/);
    assert.match(dom.window.document.body.textContent!, /could not be checked/);
  });
  await mounted(component, async (path: any) => Response.json(String(path).includes("action-items") ? source([batch]) : page([task(0)])), {}, async () => { await wait(); });
  await mounted(component, async () => new Response(null, { status: 503 }), {}, async dom => {
    await wait(); assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch|Attention 0/);
    assert.match(dom.window.document.body.textContent!, /could not be checked/);
  });
});

test("R6 shared authentication loss clears context while the other source is held", { timeout: 15000 }, async () => {
  let denied = false, release: (value: Response) => void = () => {};
  await mounted(() => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader)), async (path: any) => {
    const operator = String(path).includes("action-items");
    if (!denied) return Response.json(operator ? source([batch]) : page());
    return operator ? new Response(null, { status: 401 }) : new Promise<Response>(resolve => { release = resolve; });
  }, {}, async dom => {
    await wait(); denied = true;
    try {
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.doesNotMatch(dom.window.document.body.textContent!, /Review proposed work batch/);
      assert.match(dom.window.document.body.textContent!, /could not be checked/);
    } finally { await act(async () => release(Response.json(page()))); }
  });
});

test("R6 abandoned authentication replies cannot clear a new shared snapshot", { timeout: 15000 }, async () => {
  let calls = 0, release: (value: Response) => void = () => {};
  const component = () => h(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } }, h(PrivateHeader));
  await mounted(component, async (path: any) => {
    const operator = String(path).includes("action-items");
    calls++;
    if (calls === 2) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(operator ? source([batch]) : page());
  }, {}, async (dom, root) => {
    await wait();
    try {
      await act(async () => root.render(null));
      await act(async () => root.render(h(component)));
      await wait();
      assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
      await act(async () => release(new Response(null, { status: 401 })));
      assert.match(dom.window.document.body.textContent!, /Review proposed work batch/);
    } finally { release(Response.json(source())); }
  });
});
