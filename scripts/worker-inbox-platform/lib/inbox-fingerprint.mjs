// Turns an inbox result into a stable fingerprint.
//
// The watcher's only job is to detect that the assigned action changed. Fingerprinting the
// normalised result means an unchanged inbox produces an unchanged fingerprint even when
// GitHub returns fields in a different order, so the operator is not notified about noise.
import { createHash } from "node:crypto";

// The state an operator should read, preferring the specific state the controller requested.
// The accepted client reports a broad disposition in `state` for anything needing attention
// (for example an advisory record reports state "attention") while carrying the requested
// state in `markerState`; without this the notification says "attention" and loses the fact
// that a correction was requested.
function displayState(action) {
  for (const candidate of [action.markerState, action.state]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "unknown";
}

// Serialises a value with object keys sorted at every depth. Two reads of unchanged data must
// produce the same fingerprint even if a value nests an object whose key order is not
// guaranteed; otherwise such a field would notify the operator on every single tick. A real
// value change still produces a different string.
//
// This is defined for JSON-domain values only, which is what the accepted inbox client returns
// (it reads parsed GitHub JSON). Values outside that domain - NaN, BigInt, Symbol, or undefined
// inside an array - are not representable and are not defended against.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(element => stableStringify(element)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function normalizeActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter(action => action && Number.isSafeInteger(Number(action.issue)))
    .map(action => {
      // Fingerprint every field the accepted client reports instead of a hand-picked subset.
      // The client's contract already changed once: it now reports attention dispositions in
      // `state` and carries the requested state, trust, disposition, head, and pull request in
      // other fields. A fixed subset silently stopped detecting real changes, which is the one
      // failure a watcher must not have. Any field added later participates automatically.
      // workerId is constant for a run, so it is excluded rather than contributing noise.
      const fields = Object.keys(action)
        .filter(key => key !== "workerId" && action[key] !== undefined)
        .sort()
        .map(key => [key, typeof action[key] === "string" ? action[key] : stableStringify(action[key])]);
      return { issue: Number(action.issue), state: displayState(action), fields };
    })
    .sort((left, right) => left.issue - right.issue || left.state.localeCompare(right.state));
}

export function actionsFingerprint(actions) {
  const normalized = normalizeActions(actions);
  const canonical = JSON.stringify(normalized.map(action => [action.issue, action.state, action.fields]));
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
