"use client";

import { useEffect, useRef, useState } from "react";


const registrations = new WeakMap<ServiceWorkerContainer, Promise<ServiceWorkerRegistration>>();

export function registerOwnerPushWorkerV1(worker: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
  const registration = worker.register("/service-worker.js", { scope: "/" });
  registrations.set(worker, registration);
  void registration.catch(() => {});
  return registration;
}

/** A rejected registration must settle setup even when ready never resolves. */
export async function readyOwnerPushWorkerV1(worker: ServiceWorkerContainer, timeoutMs = 5000): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const registration = registrations.get(worker);
  const failed = registration?.then(() => new Promise<never>(() => {}));
  try {
    return await Promise.race([worker.ready, ...(failed ? [failed] : []), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("owner_push_worker_unavailable")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function PwaRegistration() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const requested = useRef(false);
  const currentRegistration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const worker = navigator.serviceWorker;
    let active = true, registration: ServiceWorkerRegistration | undefined;
    const observed = new Set<ServiceWorker>();
    const installed = () => {
      if (active) setWaiting(worker.controller && registration?.waiting?.state === "installed" ? registration.waiting : null);
    };
    const changed = () => {
      installed();
      if (requested.current) { requested.current = false; clearTimeout(deadline.current); window.location.reload(); }
    };
    const found = () => {
      for (const candidate of [registration?.installing, registration?.waiting]) {
        if (candidate && !observed.has(candidate)) { observed.add(candidate); candidate.addEventListener("statechange", installed); }
      }
      installed();
    };
    worker.addEventListener("controllerchange", changed);
    void registerOwnerPushWorkerV1(worker).then(value => {
      if (!active) return;
      registration = value; currentRegistration.current = value;
      found(); registration.addEventListener("updatefound", found);
    }).catch(() => {});
    return () => {
      active = false; worker.removeEventListener("controllerchange", changed);
      registration?.removeEventListener("updatefound", found);
      for (const candidate of observed) candidate.removeEventListener("statechange", installed);
      currentRegistration.current = undefined; requested.current = false; clearTimeout(deadline.current);
    };
  }, []);
  return waiting || message ? <p role="status" className="private-pwa-update">{message ?? "A Control Room update is ready."} {waiting && <button type="button" disabled={busy} onClick={() => {
    if (requested.current) return;
    if (!navigator.serviceWorker.controller || currentRegistration.current?.waiting !== waiting || waiting.state !== "installed") {
      setWaiting(null); setMessage("No update is waiting. You can keep using Control Room."); return;
    }
    requested.current = true; setBusy(true); setMessage("Reloading for update…");
    const failed = () => {
      requested.current = false; setBusy(false);
      setMessage("Control Room couldn't reload the update. Your current screen is kept; try again.");
    };
    deadline.current = setTimeout(failed, 10_000);
    try { waiting.postMessage({ type: "control-room.activate-update" }); }
    catch { clearTimeout(deadline.current); failed(); }
  }}>{busy ? "Reloading for update…" : "Reload for update"}</button>}</p> : null;
}
