# Control Room repository guidance

Control Room is a harness-agnostic orchestration system for projects, workers, schedules, approvals, evidence, and bounded effects. Lo-Fi Wayfarer and Content Blooms are consumers; neither defines the core architecture.

## Start every task

1. Read `docs/BUILD_STATUS.md` for the active block, accepted evidence, open risks, and required model/effort.
2. Inspect the current branch, working tree, recent commits, and relevant open GitHub issues/PRs. Do not infer current state from an earlier chat.
3. Read only the architecture documents needed for the task. `docs/CR3_BUILD_PLAN.md`, `docs/CR3_DECISION_LOG.md`, `docs/SECURITY_AND_AUTHORITY.md`, and `docs/CR5C_FINAL_SECURITY_CONTRACT.md` are the main durable sources.
4. Preserve unrelated user or worker changes. Never work directly over another agent's active checkout or branch.

## Authority

- Codex owns architecture, security boundaries, normative contracts, acceptance criteria, final review, and integration.
- Hermes and other external workers contribute through V2 GitHub jobbers. Workers must follow `skills/agent-build-worker/SKILL.md` and may start only after the serialized queue controller records `CLAIM ACCEPTED`. For authoring capsules or reviewing results, Codex uses `.agents/skills/control-room-delegation-review/SKILL.md`.
- Worker output is evidence, not architectural authority. Never self-merge worker PRs or convert blocked/negative evidence into a pass.
- Secrets, credentials, raw host identity, private infrastructure details, and production artifacts do not belong in commits, issues, PRs, fixtures, or logs.
- Installs, downloads, live integrations, native credential-store operations, persistent services, destructive cleanup, and production effects require explicit scoped authority.

## Development baseline

- Node.js: `>=22.13.0`
- Package manager: `pnpm@11.19.0`
- Deterministic preparation: run the repository stage-zero command first. If setup is required, use `CI=true` with the frozen lockfile and follow `docs/WORKER_CHECKOUT_PREPARATION.md`.
- Relevant verification, proportional to the change: `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm test:build`, and `pnpm db:verify`.
- Use feature branches and pull requests for substantive changes. Keep `main` synchronized with `origin/main` by fast-forward only.

## Platform evidence

Host qualification separates dependency preparation, effect-free runtime readiness, and the single native attempt. Never repair an architect-owned harness during qualification. macOS owner-attended operations must be run by the owner from an attached Terminal; an agent cannot type the owner phrase, approve a Keychain prompt, or claim owner presence.

## Cross-machine work

GitHub is the canonical transfer mechanism. Each computer and harness uses its own clone; do not share one live checkout or copy `node_modules`, credentials, Codex state, or temporary artifacts between machines. See `docs/CODEX_MAC_HANDOFF.md`.
