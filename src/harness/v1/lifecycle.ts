import type { HarnessRunState } from "./types";

const transitions: Readonly<Record<HarnessRunState, readonly HarnessRunState[]>> = {
  discovered: ["starting", "cancelled", "failed"],
  starting: ["running", "waiting_input", "waiting_approval", "cancelling", "disconnected", "failed", "cancelled"],
  running: ["waiting_input", "waiting_approval", "cancelling", "disconnected", "succeeded", "failed", "cancelled"],
  waiting_input: ["running", "cancelling", "disconnected", "failed", "cancelled"],
  waiting_approval: ["running", "cancelling", "disconnected", "failed", "cancelled"],
  cancelling: ["disconnected", "failed", "cancelled"],
  disconnected: ["running", "waiting_input", "waiting_approval", "cancelling", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};

export function canTransitionHarnessRun(from: HarnessRunState, to: HarnessRunState): boolean {
  return from === to || transitions[from].includes(to);
}

export function isTerminalHarnessRunState(state: HarnessRunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}
