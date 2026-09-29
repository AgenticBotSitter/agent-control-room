"use client";
import { useEffect, useRef, useState } from "react";
import { createTaskSubmissionBrowserClient } from "../../src/web/v1/task-submission-browser-client";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import type { z } from "zod";
import type { taskDeliveryStatusSchema } from "../../src/web/v1/task-delivery-wire";
import type { TaskDetail } from "../../src/web/v1/task-wire";
import type { taskSubmissionReadSchema } from "../../src/web/v1/task-submission-wire";

type SubmissionRead = z.infer<typeof taskSubmissionReadSchema>;

/** The Mac-local path is selected only by a fresh server preview, never by a browser setting. */
export function PrivateMacLocalTaskSubmission({ detail }: { detail: TaskDetail }) {
  const [client] = useState(() => createTaskSubmissionBrowserClient());
  const [read, setRead] = useState<SubmissionRead>();
  const [status, setStatus] = useState<"checking" | "ready" | "recorded" | "not_ready" | "uncertain">("checking");
  const [pending, setPending] = useState(false);
  const busy = useRef(false), generation = useRef(0);
  const { projectId, jobId } = detail.task, inputDigest = detail.inputDigest;
  useEffect(() => {
    const current = ++generation.current; let live = true;
    setRead(undefined); setStatus("checking");
    void client.read(projectId, jobId, inputDigest).then(value => {
      if (!live || current !== generation.current) return;
      setRead(value); setStatus(value.receipt ? "recorded" : value.preview && !client.hasPending() ? "ready" : client.hasPending() ? "uncertain" : "not_ready");
    }).catch(() => { if (live && current === generation.current) setStatus(client.hasPending() ? "uncertain" : "not_ready"); });
    return () => { live = false; };
  }, [client, projectId, jobId, inputDigest]);
  async function check() {
    if (busy.current) return;
    busy.current = true; setPending(true); setStatus("checking"); setRead(undefined);
    const current = ++generation.current;
    try {
      const value = await client.read(projectId, jobId, inputDigest);
      if (current === generation.current) {
        setRead(value); setStatus(value.receipt ? "recorded" : value.preview && !client.hasPending() ? "ready" : client.hasPending() ? "uncertain" : "not_ready");
      }
    } catch { if (current === generation.current) setStatus(client.hasPending() ? "uncertain" : "not_ready"); }
    finally { busy.current = false; setPending(false); }
  }
  async function submit() {
    const expected = read?.preview?.packetDigest;
    if (!expected || status !== "ready" || busy.current || client.hasPending()) return;
    busy.current = true; setPending(true); setRead(undefined); setStatus("checking");
    const current = ++generation.current;
    try {
      // Re-read immediately before posting. A vanished or changed preview is not permission to submit.
      const fresh = await client.read(projectId, jobId, inputDigest);
      if (!fresh.preview || fresh.receipt || fresh.preview.packetDigest !== expected) {
        if (current === generation.current) { setRead(fresh); setStatus(fresh.receipt ? "recorded" : "not_ready"); }
        return;
      }
      await client.submit(projectId, jobId, inputDigest, expected);
      const recorded = await client.read(projectId, jobId, inputDigest, expected);
      if (current === generation.current) { setRead(recorded); setStatus(recorded.receipt ? "recorded" : "uncertain"); }
    } catch { if (current === generation.current) setStatus(client.hasPending() ? "uncertain" : "not_ready"); }
    finally { busy.current = false; setPending(false); }
  }
  // Hosted reads have no preview; keep their existing signed-approval UI unchanged.
  if (status === "not_ready" && !read?.receipt) return null;
  if (status === "checking" && !read && !pending) return null;
  return <section className="private-panel" aria-label="Mac-local task submission"><h2>Submit local task</h2>
    {read?.preview && status === "ready" && <><p>Agent: {detail.preparedFor ?? "assigned worker"} · Task: {detail.task.title}</p>
      <p>What will run: {detail.instructions}</p><p>Preview: {read.preview.packetDigest.slice(0, 19)}…</p>
      <button type="button" disabled={pending} onClick={() => { void submit(); }}>Submit task</button></>}
    {status === "recorded" && read?.receipt && <><p role="status">Submission recorded at {read.receipt.queuedAt}. This does not confirm that an agent has started or finished.</p>
      <p>Receipt: {read.receipt.queueId}</p></>}
    {status === "uncertain" && <p role="alert">Submission could not be confirmed. Check its receipt; do not resubmit.</p>}
    {status === "not_ready" && <p role="status">This task is not ready to submit. Check again after it is assigned.</p>}
    {read?.delivery && <p>Delivery: {read.delivery.state}. Checked {read.delivery.observedAt}.</p>}
    <button type="button" disabled={pending} onClick={() => { void check(); }}>Check submission</button>
  </section>;
}

export function PrivateTaskSubmission({ projectId, jobId, inputDigest, packetDigest, client: suppliedClient }: {
  projectId: string; jobId: string; inputDigest: string; packetDigest: string; client?: ReturnType<typeof createTaskSubmissionBrowserClient>;
}) {
  const [client] = useState(() => suppliedClient ?? createTaskSubmissionBrowserClient());
  const [status, setStatus] = useState<"checking" | "not_recorded" | "recorded" | "unavailable" | "uncertain">(() => client.hasPending() ? "uncertain" : "checking");
  const [pending, setPending] = useState(false);
  const [delivery, setDelivery] = useState<z.infer<typeof taskDeliveryStatusSchema>>();
  const alive = useRef(true), busy = useRef(false), recorded = useRef(false);
  useEffect(() => {
    alive.current = true; let current = true;
    void client.read(projectId, jobId, inputDigest, packetDigest).then(value => {
      if (current) { recorded.current ||= !!value.receipt; setStatus(recorded.current ? "recorded" : client.hasPending() ? "uncertain" : "not_recorded"); setDelivery(value.delivery); }
    }).catch(() => { if (current) setStatus(client.hasPending() ? "uncertain" : "unavailable"); });
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
