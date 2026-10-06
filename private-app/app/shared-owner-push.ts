"use client";

import { useSyncExternalStore } from "react";
import { readyOwnerPushWorkerV1 } from "./pwa-registration";

export type PushStatus = { enabled: boolean; publicKey?: string; subscribed: boolean; local?: boolean; stopped?: boolean; unavailable?: boolean; message: string; checking?: boolean; refreshFailed?: boolean };
const unsupported = "This browser does not support Web Push. You can still use Control Room normally.";
export const base64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
export const endpointRequest = (endpoint: string) => ({ method: "POST", credentials: "same-origin" as const,
  headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });

export const stoppedMessage = "Phone notifications stopped — tap to turn back on";
export const actionOwners = new WeakSet<ServiceWorkerContainer>();
export const remembered = () => { try { return window.localStorage.getItem("control-room.phone-enabled") === "yes"; } catch { return false; } };
const rotationStopped = () => { try { return window.localStorage.getItem("control-room.phone-stopped") === "yes"; } catch { return false; } };
export const markRotation = (stopped: boolean) => { try { if (stopped) window.localStorage.setItem("control-room.phone-stopped", "yes"); else window.localStorage.removeItem("control-room.phone-stopped"); } catch {} };
export const remember = (enabled: boolean) => { try { if (enabled) window.localStorage.setItem("control-room.phone-enabled", "yes"); else window.localStorage.removeItem("control-room.phone-enabled"); } catch {} };
export function keyMatches(subscription: PushSubscription, publicKey: string | undefined) {
  const key = subscription.options?.applicationServerKey;
  if (!key || !publicKey) return false;
  const expected = base64url(publicKey), actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

async function phoneRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

// One browser snapshot and poll for every mounted push panel. The last
// subscriber aborts the read, clears its timer, and discards the snapshot.
const initial: PushStatus = { enabled: false, subscribed: false, message: "Checking phone notifications…" };
let snapshot = initial, hasValue = false, actionRevision = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
export function setSharedOwnerPushStatus(update: PushStatus | ((current: PushStatus) => PushStatus)) {
  snapshot = typeof update === "function" ? update(snapshot) : update;
  for (const notify of listeners) notify();
}
export function scheduleSharedOwnerPushRead() {
  clearTimeout(timer);
  if (listeners.size) timer = setTimeout(onVisible, 30_000);
}
export function invalidateSharedOwnerPushRead() {
  actionRevision++;
  request?.abort();
  setSharedOwnerPushStatus(current => ({ ...current, checking: false, refreshFailed: false }));
}
export async function refreshSharedOwnerPush() {
  if (!listeners.size || request || actionOwners.has(navigator.serviceWorker) || document.hidden) return;
  clearTimeout(timer);
  const controller = new AbortController(); request = controller;
  const revisionAtStart = actionRevision;
  setSharedOwnerPushStatus(current => ({ ...current, checking: true, refreshFailed: false }));
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await phoneRead(fetch("/api/v1/owner-web-push", { credentials: "same-origin", cache: "no-store", signal: controller.signal }), controller.signal);
    if (!response.ok) throw new Error();
    const next = await phoneRead(response.json(), controller.signal) as PushStatus;
    const worker = await phoneRead(readyOwnerPushWorkerV1(navigator.serviceWorker), controller.signal);
    const existing = await phoneRead(worker.pushManager.getSubscription(), controller.signal);
    let subscribed = false;
    if (existing && keyMatches(existing, next.publicKey) && (existing.expirationTime === null || existing.expirationTime > Date.now())) {
      const saved = await phoneRead(fetch("/api/v1/owner-web-push/status", { ...endpointRequest(existing.endpoint), signal: controller.signal }), controller.signal);
      if (!saved.ok) throw new Error();
      subscribed = (await phoneRead(saved.json(), controller.signal)).subscribed === true;
    }
    if (!listeners.size || controller.signal.aborted || actionOwners.has(navigator.serviceWorker) || revisionAtStart !== actionRevision) return;
    const stopped = rotationStopped() || !subscribed && (!!existing || remembered());
    if (stopped) subscribed = false;
    if (subscribed) remember(true);
    hasValue = true;
    setSharedOwnerPushStatus({ ...next, checking: false, refreshFailed: false, subscribed, stopped, local: !!existing, message: subscribed ? "This browser is subscribed."
      : stopped ? stoppedMessage : next.message });
  } catch {
    if (listeners.size && !actionOwners.has(navigator.serviceWorker) && revisionAtStart === actionRevision) setSharedOwnerPushStatus(current => hasValue
      ? { ...current, checking: false, refreshFailed: true }
      : { ...current, checking: false, unavailable: true, message: "Phone notifications are unavailable. Retry notification setup." });
  } finally {
    clearTimeout(deadline);
    if (request === controller) {
      request = undefined;
      scheduleSharedOwnerPushRead();
    }
  }
}

function onVisible() { void refreshSharedOwnerPush(); }
function stopped(event: MessageEvent) {
  if (event.data?.type !== "control-room.push-stopped") return;
  remember(true); markRotation(true);
  setSharedOwnerPushStatus(current => ({ ...current, stopped: true, subscribed: false, message: stoppedMessage }));
  onVisible();
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported) setSharedOwnerPushStatus({ enabled: false, subscribed: false, message: unsupported });
    else {
      window.addEventListener("focus", onVisible);
      window.addEventListener("control-room.phone-changed", onVisible);
      document.addEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.addEventListener?.("message", stopped);
      queueMicrotask(onVisible);
    }
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size) return;
    clearTimeout(timer); request?.abort(); request = undefined;
    snapshot = initial; hasValue = false; actionRevision++;
    window.removeEventListener("focus", onVisible);
    window.removeEventListener("control-room.phone-changed", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.removeEventListener?.("message", stopped);
  };
}
export function useSharedOwnerPushStatus() {
  return useSyncExternalStore(subscribe, () => snapshot, () => initial);
}
