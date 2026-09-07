"use client";
import { useEffect, useRef, useState } from "react";
import { createTaskSubmissionBrowserClient } from "../../src/web/v1/task-submission-browser-client";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import type { z } from "zod";
import type { taskDeliveryStatusSchema } from "../../src/web/v1/task-delivery-wire";

export function PrivateTaskSubmission({ projectId, jobId, inputDigest, packetDigest }: {
  projectId: string; jobId: string; inputDigest: string; packetDigest: string;
}) {
  const [client] = useState(() => createTaskSubmissionBrowserClient());
  const [status, setStatus] = useState<"checking" | "not_recorded" | "recorded" | "unavailable" | "uncertain">("checking");
  const [pending, setPending] = useState(false);
  const [delivery, setDelivery] = useState<z.infer<typeof taskDeliveryStatusSchema>>();
  const alive = useRef(true), busy = useRef(false), recorded = useRef(false);
  useEffect(() => {
    alive.current = true; let current = true;
    void client.read(projectId, jobId, inputDigest, packetDigest).then(value => {
      if (current) { recorded.current ||= !!value.receipt; setStatus(recorded.current ? "recorded" : "not_recorded"); setDelivery(value.delivery); }
    }).catch(() => { if (current) setStatus("unavailable"); });
    return () => { current = false; alive.current = false; };
  }, [client, projectId, jobId, inputDigest, packetDigest]);
  async function action(submit: boolean) {
    if (busy.current || submit && (recorded.current || status !== "not_recorded" || client.hasPending())) return;
    busy.current = true; setPending(true); setDelivery(undefined);
    try {
      if (submit) {
        await client.submit(projectId, jobId, inputDigest, packetDigest);
        if (alive.current) { recorded.current = true; setStatus("recorded"); }
      } else {
        const value = await client.read(projectId, jobId, inputDigest, packetDigest);
        if (alive.current) { recorded.current ||= !!value.receipt; setDelivery(value.delivery);
          setStatus(recorded.current ? "recorded" : client.hasPending() ? "uncertain" : "not_recorded"); }
      }
    } catch (error) {
      if (alive.current) setStatus(client.hasPending() || error instanceof BrowserRequestError && error.code === "uncertain" ? "uncertain" : "unavailable");
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <section className="private-panel" aria-label="Task submission"><h2>Send approved task</h2>
    <p>Queuing allows the connected worker to run this task if its signed permission and reservation are still valid.</p>
    <p role="status">{({ checking: "Checking submission…", not_recorded: "No submission was recorded at the last check.",
      recorded: "Submission recorded. This does not confirm that an agent has started or finished.",
      unavailable: "Submission is unavailable or you no longer have access. Check again before continuing.",
      uncertain: "Submission could not be confirmed. Check its receipt; do not send another task." })[status]}</p>
    <button type="button" disabled={pending || status !== "not_recorded" || client.hasPending()} onClick={() => { void action(true); }}>Queue approved task</button>
    {delivery && <p>{({ not_queued: "No queue record at this check.", queued: "Queued; no delivery preparation recorded.",
      prepared: "Delivery prepared; no signed envelope recorded.", staged: "Signed envelope saved; no transmission request recorded.",
      transmission_unconfirmed: "Transmission was requested, but no authenticated receipt is recorded. Do not resend.",
      receipt_recorded: "The agent recorded receipt. This does not prove execution or completion.",
      receipt_rejected: "The agent reported rejecting delivery. Inspect the task; this is not permission to retry." })[delivery.state]} Checked {delivery.observedAt}.</p>}
    <button type="button" disabled={pending || status === "checking"} onClick={() => { void action(false); }}>Check submission</button>
  </section>;
}
