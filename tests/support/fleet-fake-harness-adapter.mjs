// A deterministic stand-in for src/fleet/v1/harness-adapters.ts. It speaks the
// same shared local CLI delivery contract, so the connector cannot tell it
// apart from the real Codex, Claude Code or Hermes adapter. The behaviour is
// chosen by the machine's local harness settings ("fakeBehaviour").
export const calls = [];

export function createFleetHarnessAdapter({ harness, configuration }) {
  const behaviour = configuration.fakeBehaviour ?? "success";
  return {
    async execute({ delivery, signal }) {
      calls.push({ harness, delivery: JSON.parse(JSON.stringify(delivery)), signalIsAbortSignal: signal instanceof AbortSignal });
      const at = new Date().toISOString();
      if (behaviour === "success") return { kind: "completed", text: `Done by fake ${harness}: ${delivery.input.prompt}`,
        startedAt: at, finishedAt: at, usage: null };
      if (behaviour === "failure") return { kind: "failed", reason: "failed:process_or_output_refused",
        startedAt: at, finishedAt: at, usage: null };
      if (behaviour === "oversize") return { kind: "completed", text: "x".repeat(70 * 1024), startedAt: at, finishedAt: at, usage: null };
      if (behaviour === "throws") throw new Error("adapter exploded");
      if (behaviour === "malformed") return { kind: "completed", startedAt: at, finishedAt: at };
      if (behaviour === "timeout") {
        // Honours its own deadline, as the shared runners do.
        await new Promise(done => setTimeout(done, configuration.deadlineMs));
        return { kind: "failed", reason: "timed_out:deadline_exceeded", startedAt: at, finishedAt: new Date().toISOString(), usage: null };
      }
      if (behaviour === "until-aborted") {
        await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); });
        return { kind: "failed", reason: "canceled:aborted", startedAt: at, finishedAt: new Date().toISOString(), usage: null };
      }
      if (behaviour === "hang") return new Promise(() => {});
      throw new Error(`unknown fake behaviour ${behaviour}`);
    },
  };
}
