"use client";

import { useCallback, useSyncExternalStore } from "react";
import { readAllTaskAttention, retainTaskAttentionPages, type TaskAttentionSourceState } from "../../src/web/v1/task-attention-source";
import type { TaskAttentionPage } from "../../src/web/v1/task-attention-wire";
import { readActionInboxSource, type ActionInboxSource, type ActionInboxSourceState } from "../../src/web/v1/action-inbox-browser-client";
import { loopAttentionComplete, loopAttentionUnknown } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { buildActionInbox, type ActionInboxDisplayItem } from "../../src/web/v1/action-inbox";

export type SharedAttentionValue = { items: ActionInboxDisplayItem[]; complete: boolean; checking?: boolean; unknown?: boolean; uninspected?: boolean };
export type SharedInboxData = { tasks: TaskAttentionSourceState; operator: ActionInboxSourceState };
type Attention = { state: "loading" } | { state: "unavailable"; accessLost?: boolean; data?: SharedInboxData } | { state: "ready"; value: SharedAttentionValue; data: SharedInboxData };
const loading: Attention = { state: "loading" };
let snapshot: Attention = loading;
let previousPages: TaskAttentionPage[] = [];
let previousSource: ActionInboxSource | undefined;
const operatorAccessLost = (code: string) => ["authentication_required", "access_denied"].includes(code);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let refreshAgain = false;

/** One visible-page read shared by Home and every header. Never carry a
 * previous installation's snapshot across the last subscriber's unmount. */
export async function refreshSharedTaskAttention(afterCurrent = false) {
  if (!listeners.size || document.hidden) return;
  // Keep one follow-up read when a status change arrives during a shared read.
  if (request) { if (afterCurrent) refreshAgain = true; return; }
  clearTimeout(timer);
  const controller = new AbortController();
  request = controller;
  if (snapshot.state === "ready") {
    snapshot = { state: "ready", value: { ...snapshot.value, complete: false, checking: true }, data: snapshot.data };
    for (const notify of listeners) notify();
  }
  try {
    const transport: typeof fetch = (path, init) => fetch(path, {
      ...init, signal: AbortSignal.any([controller.signal, init?.signal ?? controller.signal]),
    });
    const clearAccess = (code: "authentication_required" | "access_denied") => {
      if (controller.signal.aborted) return;
      previousPages = []; previousSource = undefined; snapshot = { state: "unavailable", accessLost: true, data: { tasks: { state: "unavailable", code, pages: [] }, operator: { state: "unavailable", code } } };
      for (const notify of listeners) notify();
    };
    const taskRead = readAllTaskAttention(transport, controller.signal).then(tasks => {
      if (tasks.state === "unavailable" && tasks.code !== "unavailable") clearAccess(tasks.code);
      return tasks;
    });
    const operatorRead = readActionInboxSource(transport).then(operator => {
      if (operator.state === "unavailable" && operatorAccessLost(operator.code)) clearAccess(operator.code as "authentication_required" | "access_denied");
      return operator;
    });
    const [tasks, operator] = await Promise.all([taskRead, operatorRead]);
    if (!controller.signal.aborted) {
      const accessLost = tasks.state === "unavailable" && tasks.code !== "unavailable"
        || operator.state === "unavailable" && operatorAccessLost(operator.code);
      if (accessLost) {
        previousPages = []; previousSource = undefined;
        const code = tasks.state === "unavailable" && tasks.code === "access_denied" || operator.state === "unavailable" && operator.code === "access_denied" ? "access_denied" : "authentication_required";
        snapshot = { state: "unavailable", accessLost: true, data: { tasks: { state: "unavailable", code, pages: [] }, operator: { state: "unavailable", code } } };
      } else {
        previousPages = tasks.state === "available" ? tasks.pages
          : tasks.state === "unavailable" ? retainTaskAttentionPages(previousPages, tasks.pages) : previousPages;
        // An installation without an Action Inbox source (404, not_configured) has
        // nothing more to check there: task attention alone is the complete answer.
        const operatorAbsent = operator.state === "unavailable" && operator.code === "not_configured";
        previousSource = operator.state === "available" ? operator.source
          : operator.state === "unavailable" && (operator.code === "access_denied" || operatorAbsent) ? undefined : previousSource;
        const loop = previousSource?.loop;
        const items = buildActionInbox(previousPages, previousSource?.items, Date.now(), loop?.state === "available" ? loop.items : []);
        const freshTaskIds = new Set(tasks.state === "unavailable" ? tasks.pages.flatMap(page => page.items.map(item => item.task.jobId)) : []);
        const taskCountUnknown = tasks.state === "unavailable" && (!tasks.pages.length
          || previousPages.some(page => page.items.some(item => !freshTaskIds.has(item.task.jobId))));
        const unknown = taskCountUnknown || operator.state === "unavailable" && !operatorAbsent || loopAttentionUnknown(loop);
        const uninspected = loop?.state === "available" && loop.truncated;
        const complete = tasks.state === "available" && !tasks.truncated
          && (operator.state === "available" && !operator.source.truncated && loopAttentionComplete(operator.source.loop) || operatorAbsent);
        const data: SharedInboxData = { tasks: tasks.state === "unavailable" ? { ...tasks, pages: previousPages } : tasks,
          operator: operator.state === "unavailable" ? { ...operator, ...(previousSource ? { source: previousSource } : {}) } : operator };
        snapshot = !items.length && (tasks.state === "unavailable" || operator.state === "unavailable" && !operatorAbsent)
          ? { state: "unavailable", data } : { state: "ready", value: { items, complete, unknown, uninspected }, data };
      }
    }
  } catch {
    if (!controller.signal.aborted) snapshot = { state: "unavailable" };
  } finally {
    if (request === controller) {
      request = undefined;
      for (const notify of listeners) notify();
      if (listeners.size && refreshAgain) { refreshAgain = false; queueMicrotask(onVisible); }
      else if (listeners.size) timer = setTimeout(onVisible, 30_000);
    }
  }
}
function onVisible() { void refreshSharedTaskAttention(); }
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    queueMicrotask(onVisible);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      clearTimeout(timer); request?.abort(); request = undefined; snapshot = loading;
      previousPages = []; previousSource = undefined; refreshAgain = false;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}
export function useSharedTaskAttention(enabled: boolean) {
  const listen = useCallback((notify: () => void) => enabled ? subscribe(notify) : () => {}, [enabled]);
  return useSyncExternalStore(listen, () => enabled ? snapshot : loading, () => loading);
}
