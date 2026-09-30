"use client";

import { useEffect, useState } from "react";
import { readUpdaterHomeStatusV1 } from "../../src/web/v1/updater-home-status-browser";

type State = "loading" | "off" | "attention" | "not_configured";

/** A calm, display-only line. This component has no controls and its response
 * is intentionally reduced to two local presentation states. */
export function UpdaterHomeStatus() {
  const [state, setState] = useState<State>("loading");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/updater-status", { credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: controller.signal, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } })
      .then(async response => {
        if (response.status === 404) { if (!controller.signal.aborted) setState("not_configured"); return; }
        // Reuse the strict browser reader by supplying this one already-open response.
        const status = await readUpdaterHomeStatusV1(async () => response, controller.signal);
        if (!controller.signal.aborted) setState(status.state);
      }).catch(() => { if (!controller.signal.aborted) setState("attention"); });
    return () => controller.abort();
  }, []);
  if (state === "not_configured" || state === "loading") return null;
  if (state === "attention") return <p className="private-updater-status private-updater-attention" role="alert">
    <strong>Self-update needs your attention.</strong> The updater is not answering clearly.</p>;
  return <p className="private-updater-status">Self-update: Off — fixes are installed by you on this Mac.</p>;
}
