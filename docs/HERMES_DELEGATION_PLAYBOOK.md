# Hermes delegation and GitHub bootstrap playbook

**Status:** Proposed for CR-3 owner acceptance  
**Purpose:** Let Codex retain architecture and review ownership while qualified Hermes agents perform bounded work safely and concurrently.

## Bootstrap topology

Until Control Room can orchestrate its own build, the private GitHub repository is the shared coordination system:

```text
Owner -> Codex/Sol architect -> GitHub work-packet issue
                                  |-> Marvin/Hermes branch + pull request
                                  |-> Johnny5/Hermes branch + pull request
                                  |-> future worker branch + pull request
                               Codex/Sol tests and reviews
                                  |-> repair request or merge-ready result
                               Owner gate where required
```

GitHub stores source, issues, pull requests, test evidence, and decisions. It must not store credentials, private media, raw prompts containing secrets, machine tokens, or production artifacts. R2 or later Control Room artifact storage carries large outputs by immutable reference and checksum.

## Identities and access

- Keep the repository private during the internal build.
- Prefer one narrowly scoped GitHub identity or installation token per worker so actions are attributable and revocable.
- Grant repository-content and pull-request access only; do not give administration, secrets, environments, or unrelated-repository access.
- Do not copy one owner PAT to every machine.
- If a shared identity is temporarily unavoidable, every commit and pull request must include the worker ID, machine ID, harness, and model route; replace it before live integrations.
- Branch protection/rulesets should block direct pushes to `main` and require status checks when the account plan supports them. The procedural rule applies even if GitHub cannot enforce it.

## Work-order lifecycle

1. Codex delegates only when the expected implementation or host-evidence value materially exceeds packet and review cost. Architecture, security boundaries, migrations, cross-module integration, and final acceptance remain architect-owned.
2. Codex chooses one declared mode: `standard-work`, `platform-validation`, `controlled-effect`, or `independent-review`. Most isolated repository work uses `standard-work`; the machine-checkable effect contract is reserved for genuinely high-risk operations.
3. The issue contains the required work-order fields: objective, worker, exact base/branch, allowed paths, immutable inputs, acceptance commands, repair budget, environment/side-effect boundary, stop conditions, and handoff.
4. The worker reads the stable skill plus only the selected mode reference, performs preflight, and posts `WORK ORDER READY` or the exact blocker.
5. Standard work normally receives one focused correction within scope. Platform validation has a non-mutating readiness phase that cannot consume the native attempt. Controlled-effect work uses the validated `control-room-work-packet/v1` JSON, digest, effect ledger, and exact cleanup.
6. The worker changes only allowed paths, runs the exact checks, preserves failures/corrections, and opens one unmerged PR when the order requests one. A readiness-blocked platform order normally needs only an issue comment.
7. Codex/Sol reviews scope and claims first, then the mode-specific repair/readiness/effect record, cleanup, test output, and current PR/issue consistency.
8. Only accepted work is merged. A merged contribution does not advance a CR block unless the architect-owned completion gate passes.

### Work-order author readiness gate

The architect must answer these before dispatch:

- Is delegation cheaper to implement and review than architect execution, or does the worker provide otherwise unavailable host evidence?
- Is the mode proportional to the risk, without imposing a controlled-effect ledger on ordinary code work?
- Can every step run with the required pre-existing tools? For platform work, has a non-mutating readiness command proven the exact entry point before native effects?
- Does the standard repair budget permit a useful focused correction without allowing architecture or scope expansion?
- For controlled effects, does the worst-case path include each failed attempt, retry, diagnostic, helper, cache, prompt response, coordination write, and cleanup action?
- If a controlled-effect order says “one,” can all required cases safely reuse that one artifact? If not, the count is wrong before dispatch.
- Is every cleanup target or named resource individually knowable before creation, and can the native method prove exact identity, type, ownership/control, absence, and—when filesystem-backed—containment and link/reparse state without a glob or broad selector?
- Are prompt, restart, elevation, persistent-permission, and security-policy outcomes explicit? An unlisted prompt response is `stop`.
- Does an independent-review packet exclude every source author by identity/profile rather than only by model name?

If any answer is uncertain, the packet remains draft. The worker is not responsible for resolving an architect-authored ambiguity during execution.

Workers do not self-assign security-sensitive work, expand scope, merge their own changes, edit branch protections, modify credentials, or run live integrations.

## Suitable early packets

After CR-3 acceptance, the first local-model qualification packets should be disposable and independent:

1. generate additional contract fixtures from an already accepted schema;
2. add negative tests from an explicit transition table;
3. implement a small dashboard component from a fixed data contract;
4. normalize documentation links and terminology;
5. inventory macOS or Linux platform capabilities without changing the machine.

Do not begin by delegating authentication, authorization, lease semantics, secret handling, database migrations, approval binding, or protocol design.

## Work-result metadata

Every pull request records:

- work-packet issue and CR block;
- worker, machine, harness, model and relevant tool versions;
- files changed and why;
- commands/tests run with results;
- assumptions, failures, retries and known risks;
- declared work mode and repair/readiness iterations; controlled-effect work also records its execution-contract digest and planned-versus-actual effect counts;
- artifacts by immutable URI/checksum, never embedded secrets;
- whether a human or elevated approval is required.

This metadata is deliberately compatible with future Control Room job/attempt/result records. The GitHub bootstrap should be replaceable by the CR-7 northbound MCP and adapter APIs without changing how a safe task is described.

## Qualification and promotion

The first three to five packets for a route are calibration work. Track:

- first-pass test success;
- semantic defects found in review;
- security or scope violations;
- review minutes and repair cycles;
- accepted changed lines versus discarded changed lines;
- median completion time on that machine.

Promote the route only for task classes it passed. Re-run qualification after a material model, harness, dependency, OS, GPU, or toolchain change, or after two related review failures. Disk, memory and availability are dynamic scheduling signals rather than permanent qualifications.

## Review ownership

Codex/Sol remains accountable for:

- architecture and decision records;
- public contracts and state-machine semantics;
- security and trust boundaries;
- cross-module integration;
- acceptance-test selection;
- review of every Hermes pull request;
- final block completion reports and next-model recommendation.

Hermes agents contribute implementation capacity. They do not become the source of architectural truth merely because their patch is large or tests pass.

## Failure and recovery

- A stale packet can be unassigned without losing work; its branch and PR remain evidence.
- A worker that goes offline keeps no exclusive architectural state.
- Conflicting packets are stopped rather than merged opportunistically.
- A failed patch is retained in its branch/PR for diagnosis, then repaired or closed.
- GitHub unavailability pauses bootstrap dispatch; it does not authorize workers to bypass review.
- Once Control Room exists, GitHub remains the code-review system while Control Room becomes the scheduling, status, approvals, and cross-project authority layer.

