import { updaterRefuseV1 } from "./contracts.mjs";

// A deadline requests cancellation; it does not prove an effect has stopped.
// Keep the completion promise and exclusion until the actual work settles.
export function assertOwnerActionTimeoutV1(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw updaterRefuseV1("updater_owner_action_policy_refused");
}

export function beginOwnerActionV1(work, timeoutMs, timeoutCode) {
  assertOwnerActionTimeoutV1(timeoutMs);
  const controller = new AbortController();
  const action = { controller, settled: false };
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(updaterRefuseV1(timeoutCode)); resolve({ pending: true }); }, timeoutMs);
  });
  action.completion = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return work({ signal: controller.signal });
  }).then(value => ({ value }), error => ({ error })).finally(() => {
    action.settled = true; clearTimeout(timer);
  });
  action.wait = Promise.race([action.completion, deadline]);
  action.cancel = () => controller.abort(updaterRefuseV1("updater_owner_action_stopped"));
  return action;
}
