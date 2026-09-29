"use client";

import { useEffect, useState } from "react";

type PushStatus = { enabled: boolean; publicKey?: string; subscribed: boolean; message: string };
const unsupported = "This browser does not support Web Push. You can still use Control Room normally.";
const base64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));

export function OwnerWebPushSettings() {
  const [status, setStatus] = useState<PushStatus>({ enabled: false, subscribed: false, message: "Checking phone notifications…" });
  const [pending, setPending] = useState(false);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  useEffect(() => { if (!supported) { setStatus({ enabled: false, subscribed: false, message: unsupported }); return; }
    void fetch("/api/v1/owner-web-push", { credentials: "same-origin", cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error(); const next = await response.json() as PushStatus;
      const existing = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      setStatus({ ...next, subscribed: existing !== null, message: existing ? "This browser is subscribed." : next.message });
    }).catch(() => setStatus({ enabled: false, subscribed: false, message: "Phone notifications are unavailable. No subscription was changed." }));
  }, [supported]);
  const subscribe = async () => { if (!status.publicKey || !supported) return; setPending(true); try {
    const permission = await Notification.requestPermission(); if (permission !== "granted") throw new Error("permission");
    const worker = await navigator.serviceWorker.ready;
    const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64url(status.publicKey) });
    const response = await fetch("/api/v1/owner-web-push", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
    if (!response.ok) throw new Error(); setStatus(current => ({ ...current, subscribed: true, message: "This browser is subscribed. You can send a test notification." }));
  } catch { setStatus(current => ({ ...current, message: "The browser did not grant notification permission or the subscription could not be saved. Nothing else changed." })); } finally { setPending(false); } };
  const unsubscribe = async () => { if (!supported) return; setPending(true); try {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (subscription) { const response = await fetch("/api/v1/owner-web-push", { method: "DELETE", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) }); if (!response.ok) throw new Error(); await subscription.unsubscribe(); }
    setStatus(current => ({ ...current, subscribed: false, message: "This browser is unsubscribed." }));
  } catch { setStatus(current => ({ ...current, message: "The subscription could not be removed. It was left unchanged." })); } finally { setPending(false); } };
  const test = async () => { setPending(true); try { const response = await fetch("/api/v1/owner-web-push/test", { method: "POST", credentials: "same-origin" }); if (!response.ok) throw new Error(); setStatus(current => ({ ...current, message: "A test notification was sent to this browser." })); } catch { setStatus(current => ({ ...current, message: "The test notification could not be sent. The saved subscription was not changed." })); } finally { setPending(false); } };
  return <section className="private-panel" aria-labelledby="owner-web-push-heading"><h2 id="owner-web-push-heading">Phone notifications</h2>
    <p>Only this owner browser can subscribe. Notices are quiet by default and contain only a short title and a Control Room link.</p>
    <p role="status" aria-live="polite">{status.message}</p><div className="private-actions">
      <button type="button" disabled={pending || !status.enabled || status.subscribed} onClick={() => void subscribe()}>Subscribe this browser</button>
      <button type="button" disabled={pending || !status.subscribed} onClick={() => void unsubscribe()}>Unsubscribe this browser</button>
      <button type="button" disabled={pending || !status.subscribed} onClick={() => void test()}>Send test</button>
    </div></section>;
}
