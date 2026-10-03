import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { renderLocalOwnerSignInPageV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { sha256Digest } from "../src/security";

function worker(windows: any[] = []) {
  const handlers: Record<string, any> = {}, state = { opened: [] as string[], messages: [] as any[], shown: [] as any[] };
  const clients = { matchAll: async () => windows, openWindow: async (link: string) => { state.opened.push(link); } };
  const self = { location: { origin: "https://control.invalid" }, addEventListener(name: string, fn: any) { handlers[name] = fn; },
    registration: { async showNotification(title: string, options: any) { state.shown.push({ title, options }); } } };
  vm.runInNewContext(readFileSync("private-app/app/service-worker.js", "utf8"), { self, clients, Response, URL, fetch: async () => { throw new Error("offline"); } });
  const fire = async (name: string, event: any) => { const waits: Promise<any>[] = []; handlers[name]({ ...event, waitUntil(value: Promise<any>) { waits.push(value); } }); await Promise.all(waits); };
  return { fire, state, handlers };
}
const click = (link: string) => ({ notification: { close() {}, data: { link } } });

test("R7I-04: subscription change notifies open owner windows without silently subscribing", async () => {
  const messages: any[] = [];
  const w = worker([{ postMessage(value: any) { messages.push(value); } }]);
  assert.equal(typeof w.handlers.pushsubscriptionchange, "function");
  await w.fire("pushsubscriptionchange", { oldSubscription: { options: {} }, newSubscription: null });
  assert.equal(messages[0].type, "control-room.push-stopped");
});

test("R7I-06: notification tap reuses an owner window and falls back to a new window", async () => {
  const calls: any[] = [];
  const w = worker([{ url: "https://control.invalid/projects", async navigate(link: string) { calls.push(link); return this; }, async focus() { calls.push("focus"); } }]);
  await w.fire("notificationclick", click("/needs-me"));
  assert.deepEqual(calls, ["/needs-me", "focus"]); assert.equal(w.state.opened.length, 0);
  const empty = worker(); await empty.fire("notificationclick", click("/needs-me")); assert.deepEqual(empty.state.opened, ["/needs-me"]);
  const broken = worker([{ url: "https://control.invalid/", async navigate() { throw new Error("closed"); }, async focus() {} }]);
  await broken.fire("notificationclick", click("/needs-me")); assert.deepEqual(broken.state.opened, ["/needs-me"]);
});

test("R7I-06: notification links reject foreign, encoded and script destinations", async () => {
  for (const link of ["//evil.invalid", "/\\evil.invalid", "/needs-me?next=https://evil.invalid", "/%2f%2fevil.invalid", "javascript:alert(1)", "/settings/../sign-out"]) {
    const w = worker(); await w.fire("notificationclick", click(link)); assert.deepEqual(w.state.opened, []);
  }
});

test("R7I-06: signed-out taps carry only an allowed destination through sign-in", async () => {
  const origin = "http://127.0.0.1:3210";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:fixture", localOwnerSession: {
    schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:fixture", provider: "local", subject: "owner:fixture",
    ownerCodeDigest: sha256Digest({ ownerCode: "fixture-code-long-enough" }), sessionSeconds: 900 },
    database: { client: { async query() { throw new Error("database_must_not_be_used"); } } as any, close: async () => {}, isAvailable: () => true } });
  try {
    for (const path of ["/needs-me", "/projects/project:fixture/tasks/job:fixture"]) {
      const redirect = await app.handle(new Request(origin + path), () => { throw new Error("signed_out_render"); });
      assert.equal(redirect.status, 303);
      assert.equal(new URL(redirect.headers.get("location")!).searchParams.get("next"), path);
      const signIn = await app.handle(new Request(redirect.headers.get("location")!), () => new Response("unused"));
      assert.equal(signIn.status, 200); assert.match(await signIn.text(), new RegExp(`location.assign\\(${JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    }
    for (const query of ["next=https://evil.invalid", "next=%2f%2fevil.invalid", "next=%2f%5cevil.invalid", "next=%2fneeds-me&next=%2fprojects", "unknown=1"]) {
      const response = await app.handle(new Request(`${origin}/session?${query}`), () => new Response("unused")); assert.equal(response.status, 400);
    }
  } finally { await app.close(); }
});

test("R7I-06: successful code returns to the tapped item; a failed code stays on sign-in", async () => {
  for (const ok of [false, true]) {
    const html = await renderLocalOwnerSignInPageV1("/needs-me").text();
    let listener: any; const assigned: string[] = []; const message = { textContent: "" };
    const document = { getElementById(id: string) { return id === "sign-in" ? { addEventListener(_name: string, fn: any) { listener = fn; } } : message; } };
    // int9's sign-in script disables its button, bounds the request and words the
    // refusal by status: a failed code is the server's 401, as in production.
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { document, FormData: class { get() { return "fixture-code"; } },
      AbortSignal, navigator: { onLine: true },
      fetch: async () => ({ ok, status: ok ? 200 : 401 }), location: { assign(path: string) { assigned.push(path); } } });
    await listener({ preventDefault() {}, currentTarget: { querySelector: () => ({ disabled: false }) } });
    assert.deepEqual(assigned, ok ? ["/needs-me"] : []);
    if (!ok) assert.match(message.textContent, /not accepted/);
  }
  assert.throws(() => renderLocalOwnerSignInPageV1("//evil.invalid"));
});

test("R7I-06: foreign and vanished windows cannot absorb a notification tap", async () => {
  let foreignNavigations = 0;
  const foreign = worker([{ url: "https://evil.invalid/", async navigate() { foreignNavigations++; return null; } }]);
  await foreign.fire("notificationclick", click("/needs-me")); assert.equal(foreignNavigations, 0); assert.deepEqual(foreign.state.opened, ["/needs-me"]);
  const vanished = worker([{ url: "https://control.invalid/", async navigate() { return null; } }]);
  await vanished.fire("notificationclick", click("/needs-me")); assert.deepEqual(vanished.state.opened, ["/needs-me"]);
});
