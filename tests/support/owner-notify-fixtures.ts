import { createECDH, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

export const now = Date.parse("2026-10-01T12:00:00Z");
export const vapid = { subject: "mailto:fixture@example.invalid", ...webpush.generateVAPIDKeys() };
const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
export const subscription = { id: "push:fixture", tenantId: "tenant:fixture",
  endpoint: "https://fcm.googleapis.com/fcm/send/fixture", p256dh: ecdh.getPublicKey().toString("base64url"),
  auth: randomBytes(16).toString("base64url"), expiresAt: null };
export const uid = (n: number) => `push:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export class AlertStore {
  rows: any[]; queued: string[] = []; subscriptionsValue: any[];
  constructor(rows: any[] = []) { this.rows = rows; this.subscriptionsValue = [{ ...subscription, expires_at: null }]; }
  async subscriptions() { return this.subscriptionsValue; }
  async pending(limit = 50) { return this.rows.filter(r => !r.sent && !r.reserved && r.attempts < 10).slice(0, limit).map(r => ({ ...r })); }
  async begin(id: string) { const row = this.rows.find(r => r.id === id); if (!row || row.sent || row.reserved) return false; row.reserved = true; row.attempts++; return true; }
  async finish(id: string, value: any) { const row = this.rows.find(r => r.id === id); row.reserved = false; Object.assign(row, value); }
  async queue(template: string) { this.queued.push(template); this.rows.push({ id: uid(this.rows.length + 1), template, attempts: 0 }); }
}
export async function scratch(t: any) { const root = await mkdtemp(join(tmpdir(), "owner-notify-state-")); await mkdir(join(root, "updater-state")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

export async function mounted(component: any, fetcher: any, worker: any, work: (dom: JSDOM, root: any) => Promise<void>) {
  const dom = new JSDOM("<div id=root></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const names = ["window", "document", "navigator", "Notification", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(dom.window.navigator, "serviceWorker", { value: worker });
  (dom.window as any).PushManager = function () {}; (dom.window as any).Notification = { requestPermission: async () => "granted" };
  const values: any = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Notification: (dom.window as any).Notification, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await act(async () => { root.render(createElement(component)); }); await work(dom, root); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [name, desc] of saved) { if (desc) Object.defineProperty(globalThis, name, desc); else delete (globalThis as any)[name]; } }
}
export const browserSub = () => ({ endpoint: subscription.endpoint, expirationTime: null, options: { applicationServerKey: Buffer.from(vapid.publicKey, "base64url") }, async unsubscribe() { return true; }, toJSON() { return { endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }; } });
export const statusReply = () => Response.json({ enabled: true, subscribed: false, publicKey: vapid.publicKey, message: "Can subscribe" });
export const button = (dom: JSDOM, text: string) => [...dom.window.document.querySelectorAll("button")].find(b => b.textContent === text)!;

