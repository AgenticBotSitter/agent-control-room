# Platform-validation mode

Use when the value of delegation is evidence from a real macOS, Windows, Linux, VPS, GPU, service, or other host environment. The architect owns the harness and acceptance logic; the worker owns accurate execution evidence.

## Two separate phases

### 1. Readiness

Run only the non-mutating readiness commands named by the order. Stage zero must use stock Node only and report whether the pinned repository dependencies are present before any `tsx` entry is attempted. Runtime readiness then proves module resolution, working directory, helper/tool availability, output capture, and scratch-parent suitability without generating credentials or invoking the native provider.

Readiness has its own repair allowance. The order may permit bounded fixes such as selecting the named existing runtime, correcting cwd/PATH for the current process, or refreshing the exact base. It must explicitly say whether a readiness command may be repeated. Readiness attempts never consume the native execution count because they cannot reach native effects.

Do not install dependencies, approve build scripts, edit the harness, change host policy, or create an alternate wrapper unless the order specifically assigns that setup work.

If readiness cannot pass within its allowance, report `blocked` and stop before native scratch, credential, or provider effects.

### 2. Native execution

Only after readiness passes, create the exact bounded scratch/resource and run the immutable repository harness using the command in the order. Do not copy or edit it.

When an order declares `owner-action-required`, the worker does **not** create native scratch or run the native command. It posts the exact owner-action boundary and stops. The owner runs the repository launcher from the required attached session; after that captured outcome exists, the worker may resume only the report/cleanup verification explicitly assigned by the order. A worker-supplied token or comment never proves that a human is present.

The order states the native attempt count, cleanup, prompt/operator rules, and safe outcome categories. Once a native effect starts, a failure consumes that attempt. Do not rerun unless a second attempt was expressly budgeted.

A captured zero or nonzero harness exit is an outcome to clean up and report, not permission to diagnose by mutation. A true inability to invoke or capture the preflight-verified command follows the order's emergency cleanup/stop rule.

## Evidence and cleanup

Report readiness separately from native evidence. Source inspection is `documented`; only the real host run is `observed`. A fresh process is not a service/container restart, and one user profile does not prove another.

Before deleting, resolve and inspect every exact packet-owned target, verify type, ownership, containment, and link state, delete without a glob or broad selector, and verify absence. If cleanup fails, stop without escalation or broader deletion.

## Handoff

Use a compact platform report containing readiness commands/attempts, the exact harness commit/command and one outcome, observed cases, native side effects, cleanup proof, deferred claims, validation/scope checks, and disposition.

Open a report-only PR only when the order requests it. A readiness-blocked order normally needs only an issue comment, not a branch or PR.

