"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Worker = Readonly<{ kind: string; state: "ready" | "unavailable"; proof: "proven" | "not_proven" }>;
export type LocalProjectSection = "overview" | "work" | "reviews" | "activity" | "files";
export type LocalStatus = Readonly<{ taskWorkersStarted: boolean; instruction?: string; workers: readonly Worker[];
  projectSections: readonly LocalProjectSection[] }>;
type Runtime = Readonly<{ mode: "checking" | "local" | "hosted"; status?: LocalStatus }>;
const RuntimeContext = createContext<Runtime>({ mode: "checking" });

function parseLocalStatus(value: unknown): LocalStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.taskWorkersStarted !== "boolean" || !Array.isArray(record.workers)
    || record.instruction !== undefined && typeof record.instruction !== "string"
    || !Array.isArray(record.projectSections) || record.projectSections.some(section =>
      !["overview", "work", "reviews", "activity", "files"].includes(String(section)))
    || record.workers.some(worker => !worker || typeof worker !== "object" || Array.isArray(worker)
      || typeof worker.kind !== "string" || !["ready", "unavailable"].includes(worker.state)
      || !["proven", "not_proven"].includes(worker.proof))) return undefined;
  return record as LocalStatus;
}

/** A successful, authenticated local-worker read identifies the Mac-local host.
 * Errors never optimistically expose the hosted-only navigation. */
export function LocalRuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<Runtime>({ mode: "checking" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/local-workers", { credentials: "same-origin", cache: "no-store",
          redirect: "error", headers: { accept: "application/json" }, signal: controller.signal });
        if (response.status === 404) { if (!controller.signal.aborted) setRuntime({ mode: "hosted" }); return; }
        if (!response.ok) return;
        const status = parseLocalStatus(await response.json());
        if (status && !controller.signal.aborted) setRuntime({ mode: "local", status });
      } catch { /* Keep only the shared routes visible when the host cannot be identified. */ }
    })();
    return () => controller.abort();
  }, []);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useLocalRuntime() { return useContext(RuntimeContext); }

/** Lets render tests supply a settled runtime mode without a network read. */
export const LocalRuntimeContextV1 = RuntimeContext;
