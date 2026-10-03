"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Worker = Readonly<{ kind: string; state: "ready" | "unavailable"; proof: "proven" | "not_proven" }>;
export type LocalProjectSection = "overview" | "inbox" | "work" | "pipelines" | "agents" | "reviews" | "activity" | "automations" | "files" | "settings";
export type LocalStatus = Readonly<{ taskWorkersStarted: boolean; instruction?: string; workers: readonly Worker[];
  projectSections: readonly LocalProjectSection[] }>;

/** What the host could not be told, and why the page may still show it.
 *
 * `unreadable` is a SETTLED state, not a pending one, and that is the whole
 * point (R4U-09). The read that decides Mac-local versus hosted used to leave
 * `mode` at "checking" on every outcome except 404 and a parsable body, so a
 * 503, a 500, an unparsable 200 or a thrown network error left the page
 * checking FOREVER: Home gates its polling on `mode !== "checking"`, so the
 * dashboard never issued a single read and both worker panels sat on "Loading
 * saved worker signals…" indefinitely -- measured more than 30 seconds later in
 * a real browser, while every other panel on the page said a plain "unavailable".
 *
 * The unresolved alternative -- picking "hosted" on failure -- was rejected: that
 * is exactly the "optimistically expose the hosted-only navigation" this
 * provider exists to prevent, and it would present fleet panels on an install
 * that has no fleet. So the mode stays unresolved and the pages are told the
 * host could not be identified, which is a fact. `retried` records that another
 * attempt is worth making rather than that the answer is now "hosted".
 */
export type LocalRuntimeUnreadable = Readonly<{ reason: "status" | "unparsable" | "network" | "aborted"; retried: boolean }>;
export type LocalRuntime = Readonly<{ mode: "checking" | "local" | "hosted"; status?: LocalStatus;
  unreadable?: LocalRuntimeUnreadable }>;

export function localWorkerStateLabel(worker: LocalStatus["workers"][number]) {
  const startup = worker.state === "ready" ? "Startup check passed" : "Startup check unavailable";
  const proof = worker.proof === "proven" ? "result proof recorded this host run" : "no result proof recorded this host run";
  return `${startup} · ${proof}`;
}
const RuntimeContext = createContext<LocalRuntime>({ mode: "checking" });

export function parseLocalStatusV1(value: unknown): LocalStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.taskWorkersStarted !== "boolean" || !Array.isArray(record.workers)
    || record.instruction !== undefined && typeof record.instruction !== "string"
    || !Array.isArray(record.projectSections) || record.projectSections.some(section =>
      !["overview", "inbox", "work", "pipelines", "agents", "reviews", "activity", "automations", "files", "settings"].includes(String(section)))
    || record.workers.some(worker => !worker || typeof worker !== "object" || Array.isArray(worker)
      || typeof worker.kind !== "string" || !["ready", "unavailable"].includes(worker.state)
      || !["proven", "not_proven"].includes(worker.proof))) return undefined;
  return record as LocalStatus;
}

/** A successful, authenticated local-worker read identifies the Mac-local host.
 * Errors never optimistically expose the hosted-only navigation -- and they now
 * SETTLE, which is the other half of the rule (R4U-09, see `LocalRuntime`). */
export function LocalRuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<LocalRuntime>({ mode: "checking" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/local-workers", { credentials: "same-origin", cache: "no-store",
          redirect: "error", headers: { accept: "application/json" }, signal: controller.signal });
        if (response.status === 404) { if (!controller.signal.aborted) setRuntime({ mode: "hosted" }); return; }
        if (!response.ok) {
          // The one line R4U-09 needed. `retried` is false because this is the
          // first attempt: the page shows "could not be checked", never a mode.
          if (!controller.signal.aborted) setRuntime({ mode: "checking", unreadable: { reason: "status", retried: false } });
          return;
        }
        const status = parseLocalStatusV1(await response.json());
        if (status) { if (!controller.signal.aborted) setRuntime({ mode: "local", status }); return; }
        // A 200 this build cannot read is unreadable, not "hosted". Falling
        // through to the settled-unreadable state is what keeps a shape change
        // from looking like a silent upgrade to a different product.
        if (!controller.signal.aborted) setRuntime({ mode: "checking", unreadable: { reason: "unparsable", retried: false } });
      } catch (error) {
        // An abort is the unmount's own doing, not a failed read: it must not
        // settle into a state that outlives the component. Everything else is a
        // network failure and does settle.
        if (controller.signal.aborted) return;
        setRuntime({ mode: "checking",
          unreadable: { reason: error instanceof TypeError ? "network" : "aborted", retried: false } });
      }
    })();
    return () => controller.abort();
  }, []);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useLocalRuntime() { return useContext(RuntimeContext); }

/** Lets render tests supply a settled runtime mode without a network read. */
export const LocalRuntimeContextV1 = RuntimeContext;
