// Turns an inbox result into a stable fingerprint.
//
// The watcher's only job is to detect that the assigned action changed. Fingerprinting the
// normalised result means an unchanged inbox produces an unchanged fingerprint even when
// GitHub returns fields in a different order, so the operator is not notified about noise.
import { createHash } from "node:crypto";

export function normalizeActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter(action => action && Number.isSafeInteger(Number(action.issue)))
    .map(action => ({
      issue: Number(action.issue),
      state: typeof action.state === "string" ? action.state : "",
      instruction: String(action.instructionUrl ?? action.issueUrl ?? ""),
    }))
    .sort((left, right) => left.issue - right.issue || left.state.localeCompare(right.state));
}

export function actionsFingerprint(actions) {
  const normalized = normalizeActions(actions);
  const canonical = JSON.stringify(normalized.map(action => [action.issue, action.state, action.instruction]));
  return Object.freeze({
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
    canonical,
    count: normalized.length,
    issues: normalized.map(action => action.issue),
    states: normalized.map(action => `${action.issue}:${action.state}`),
  });
}

// previous === undefined means this is the first observation, which is a baseline rather
// than a change. An empty inbox is only worth a notification when it replaced real work.
export function describeChange({ previous, current, workerId }) {
  if (!previous) {
    return current.count === 0
      ? { changed: false, kind: "baseline-empty", notify: false, message: `No action assigned to worker ${workerId}.` }
      : {
        changed: true,
        kind: "baseline-action",
        notify: true,
        message: `Action detected for worker ${workerId}: ${current.states.join(", ")}.`,
      };
  }
  if (previous.fingerprint === current.fingerprint) {
    return { changed: false, kind: "unchanged", notify: false, message: `Unchanged for worker ${workerId}.` };
  }
  if (current.count === 0) {
    return {
      changed: true,
      kind: "action-cleared",
      notify: true,
      message: `All assigned action cleared for worker ${workerId}.`,
    };
  }
  return {
    changed: true,
    kind: "action-changed",
    notify: true,
    message: `Assigned action changed for worker ${workerId}: ${current.states.join(", ")}.`,
  };
}
