"use client";

import { useEffect, useRef, useState } from "react";
import { useSharedOwnerPushStatus, setSharedOwnerPushStatus, refreshSharedOwnerPush, scheduleSharedOwnerPushRead,
  invalidateSharedOwnerPushRead, actionOwners, remembered, remember, markRotation, stoppedMessage,
  base64url, endpointRequest, keyMatches, type PushStatus } from "./shared-owner-push";
import { readyOwnerPushWorkerV1, registerOwnerPushWorkerV1 } from "./pwa-registration";

export function OwnerWebPushSettings({ attentionOnly = false }: { attentionOnly?: boolean } = {}) {
  const status = useSharedOwnerPushStatus();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const setStatus = (update: Parameters<typeof setSharedOwnerPushStatus>[0]) => {
    if (mounted.current) setSharedOwnerPushStatus(update);
  };
  const setupRequest = useRef<AbortController | undefined>(undefined);
  const testRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; testRequest.current?.abort(); setupRequest.current?.abort(); };
  }, []);
  const begin = () => {
    if (inFlight.current || actionOwners.has(navigator.serviceWorker)) return false;
    actionOwners.add(navigator.serviceWorker); invalidateSharedOwnerPushRead();
    inFlight.current = true; setPending(true); return true;
  };
  const finish = () => { actionOwners.delete(navigator.serviceWorker); inFlight.current = false; if (mounted.current) setPending(false); scheduleSharedOwnerPushRead(); };
  // Browser capability changes presentation only after hydration. The server
  // and the first client render must both show the same pending status (int9fix,
  // React #418 on /settings).
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  }, []);
  const subscribe = async () => {
    if (!status.publicKey || !supported) return;
    if (!begin()) return;
    let created: PushSubscription | undefined;
    const controller = new AbortController(); setupRequest.current = controller;
    const signal = controller.signal;
    try {
      const permission = await Notification.requestPermission();
      signal.throwIfAborted();
      if (permission !== "granted") throw new Error("permission");
      const config = await fetch("/api/v1/owner-web-push", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!config.ok) throw new Error("configuration_unavailable");
      const current = await config.json() as PushStatus;
      if (!current.enabled || !current.publicKey) throw new Error("configuration_unavailable");
      signal.throwIfAborted();
      const worker = await readyOwnerPushWorkerV1(navigator.serviceWorker);
      signal.throwIfAborted();
      let existing = await worker.pushManager.getSubscription();
      signal.throwIfAborted();
      if (existing && (!keyMatches(existing, current.publicKey) || existing.expirationTime !== null && existing.expirationTime <= Date.now())) {
        const removed = await fetch("/api/v1/owner-web-push", { ...endpointRequest(existing.endpoint), method: "DELETE", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        if (!removed.ok) throw new Error("old_subscription_removal_failed");
        if (!await existing.unsubscribe()) throw new Error("old_subscription_removal_failed");
        existing = null;
        signal.throwIfAborted();
      }
      const subscription = existing ?? (created = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64url(current.publicKey) }));
      signal.throwIfAborted();
      const response = await fetch("/api/v1/owner-web-push", { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
      if (!response.ok) throw new Error();
      signal.throwIfAborted();
      remember(true); markRotation(false);
      window.dispatchEvent(new window.Event("control-room.phone-changed"));
      setStatus(current => ({ ...current, stopped: false, unavailable: false, subscribed: true, local: true, message: "This browser is subscribed. You can send a test notification." }));
    } catch {
      const removed = created ? await created.unsubscribe().catch(() => false) : false;
      if (mounted.current) setStatus(current => ({ ...current, subscribed: false, local: created ? !removed : current.local,
        message: "The browser did not grant notification permission or the subscription could not be saved. You can retry." }));
    } finally { if (setupRequest.current === controller) setupRequest.current = undefined; finish(); }
  };
  const unsubscribe = async () => {
    if (!supported) return;
    if (!begin()) return;
    try {
      const subscription = await (await readyOwnerPushWorkerV1(navigator.serviceWorker)).pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/v1/owner-web-push", { ...endpointRequest(subscription.endpoint), method: "DELETE" });
        if (!response.ok) throw new Error();
        setStatus(current => ({ ...current, subscribed: false }));
        if (!await subscription.unsubscribe()) {
          setStatus(current => ({ ...current, local: true, message: "The saved registration was removed, but the browser subscription could not be removed. Retry removal." }));
          return;
        }
      }
      remember(false); markRotation(false);
      window.dispatchEvent(new window.Event("control-room.phone-changed"));
      setStatus(current => ({ ...current, stopped: false, unavailable: false, subscribed: false, local: false, message: "This browser is unsubscribed." }));
    } catch { setStatus(current => ({ ...current, message: "The subscription could not be removed. Check its status and retry." })); }
    finally { finish(); }
  };
  const test = async () => {
    if (!begin()) return;
    const controller = new AbortController();
    testRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(new Error("test_timeout")), 10_000);
    let onAbort: () => void = () => {};
    try {
      await Promise.race([(async () => {
        const subscription = await (await readyOwnerPushWorkerV1(navigator.serviceWorker)).pushManager.getSubscription();
        controller.signal.throwIfAborted();
        if (!subscription) throw new Error();
        const response = await fetch("/api/v1/owner-web-push/test", { ...endpointRequest(subscription.endpoint), signal: controller.signal });
        if (!response.ok || (await response.json()).accepted !== true) throw new Error();
      })(), new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      })]);
      if (mounted.current) setStatus(current => ({ ...current, message: "The push service accepted a test for this browser. Check your phone; receipt is not confirmed." }));
    } catch {
      if (mounted.current) setStatus(current => ({ ...current, message: controller.signal.reason?.message === "test_timeout"
        ? "The test request timed out. You can try again; receipt is not confirmed. The saved subscription was not changed."
        : "The test notification could not be sent. The saved subscription was not changed." }));
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onAbort);
      if (testRequest.current === controller) testRequest.current = undefined;
      finish();
    }
  };
  if (attentionOnly && status.refreshFailed && !status.stopped) return <p role="alert">{status.message} Couldn't refresh. Phone notifications could not be checked. <a href="/settings">Retry phone notifications</a></p>;
  if (attentionOnly && status.checking && status.publicKey && !status.stopped) return <p role="status">{status.message} Checking…</p>;
  if (attentionOnly && status.unavailable && !status.stopped && remembered()) return <p role="alert">Phone notifications could not be checked. <a href="/settings">Retry phone notifications</a></p>;
  if (attentionOnly) return status.stopped ? <p role="alert"><button type="button" disabled={pending}
    onClick={() => { if (status.enabled && status.publicKey) void subscribe(); else window.location.assign("/settings"); }}>{stoppedMessage}</button>{pending ? " Checking phone notifications…" : status.checking ? " Checking…" : status.refreshFailed ? " Couldn't refresh." : null}</p> : null;
  return <section className="private-panel" aria-labelledby="owner-web-push-heading"><h2 id="owner-web-push-heading">Phone notifications</h2>
    <p>Only this owner browser can subscribe. Notices are quiet by default and contain only a short title and a Control Room link.</p>
    <p role="status" aria-live="polite">{status.message}{status.checking ? " Checking…" : status.refreshFailed ? " Couldn't refresh." : null}</p><div className="private-actions">
      <button type="button" disabled={pending || !status.enabled || status.subscribed} onClick={() => void subscribe()}>Subscribe this browser</button>
      <button type="button" disabled={pending || !status.local} onClick={() => void unsubscribe()}>Unsubscribe this browser</button>
      <button type="button" disabled={pending || !status.subscribed} onClick={() => void test()}>Send test</button>
      {supported && !status.enabled ? <button type="button" disabled={pending} onClick={() => { void registerOwnerPushWorkerV1(navigator.serviceWorker); void refreshSharedOwnerPush(); }}>Retry notification setup</button> : null}
    </div></section>;
}
