# Control Room research follow-ups for Marvin

**Purpose:** Close only the remaining architecture-gating gaps. Do not perform another broad harness or dashboard survey.

Treat existing dossier recommendations as hypotheses. Use current official documentation, exact repository/package versions, and hands-on disposable tests. Never expose or record credential values.

## 1. Claude Code and Claude Agent SDK correction + live spike

The existing dossier has no live CLI execution and its license conclusion conflicts with the current public Python SDK repository. Produce a component-level reconciliation for:

- Claude Code CLI/application;
- TypeScript Claude Agent SDK;
- Python Claude Agent SDK;
- any bundled CLI/runtime pulled by each SDK;
- example/plugin repositories considered for reuse.

Record exact licenses and redistribution limits separately. Then run on the intended Mac environment:

- headless start and structured stream;
- capture session ID;
- resume;
- cancel mid-turn and recover;
- `PreToolUse` deny;
- interactive ask/defer and later decision where supported;
- subagent start/completion events;
- usage/cost fields;
- worktree and permission behavior.

Return sanitized event schemas and a recommendation: TypeScript SDK primary, CLI primary, or another supported seam, with fallback.

## 2. Current Hermes lifecycle and schema spike

The source audit inspected Hermes v0.20.4 while hundreds of commits behind upstream. Do not update a production installation as part of research. Use an isolated checkout or disposable profile, pin the tested commit/version, and capture:

- authenticated start/stream/steer/interrupt/resume schemas;
- API server versus serve/tui-gateway responsibilities;
- dashboard REST endpoints needed for read-only worker detail;
- profile routing;
- session/job/usage correlation;
- cancellation and reconnect behavior;
- dashboard plugin-to-local-node-bridge pattern;
- Kanban API/event mapping without cross-machine SQLite/R2 replication.

Recommend one execution seam and one read/management seam. Do not recommend Hermes Kanban as Control Room's global bus.

## 3. Durable workflow engine proof

The current Hatchet recommendation is preliminary and relies partly on ecosystem knowledge. Use current official docs and pinned releases to compare:

- Hatchet;
- DBOS;
- a minimal PostgreSQL-native queue/state-machine implementation compatible with the existing Control Room schema.

Run a disposable proof for each serious finalist:

1. start a three-step workflow;
2. pause for an external approval;
3. kill the worker and/or server;
4. restart;
5. prove exactly-once effect through idempotency rather than assuming exactly-once execution;
6. cancel;
7. retry a failed step;
8. inspect history;
9. measure VPS CPU, RAM, storage, and operational components.

Also verify auth defaults, migration/versioning, schedule support, SDK stability, and exact server/SDK licenses. Return one Adopt/Wrap/Build decision with a fallback.

## 4. Windows node runner and isolation

The existing runner dossier incorrectly treats Windows as out of scope; the Windows PC is an initial worker. Research and, where safe, test:

- native Windows Service installation and recovery;
- outbound HTTPS/WebSocket reconnect;
- process-tree cancellation;
- Job Objects/resource limits;
- filesystem/worktree isolation;
- Docker Desktop/WSL2 versus native execution;
- GPU job handling for the RTX 3070;
- disk-pressure and offload behavior;
- sleep, reboot, update, and locked-session behavior;
- Codex, Claude Code, Hermes, FFmpeg, and future Unreal execution paths;
- node-local secret injection without exposing values to unrelated processes.

Produce a macOS/Linux/Windows capability and isolation matrix with tested fallbacks. Do not claim Seatbelt, containers, or Windows Sandbox are sufficient security boundaries without an explicit threat model and test.

## 5. Bitwarden and 1Password provider contract

The first build requires both providers. Use official current documentation to compare password-manager and secrets-manager products rather than treating them as interchangeable.

For each provider determine:

- supported nonhuman/service authentication;
- collection/vault/project scoping;
- CLI, SDK, Connect/API, or harness-native integration;
- macOS, Windows, and Linux support;
- headless refresh and expiration;
- audit depth by product/tier;
- rotation and revocation;
- secure process injection options;
- offline/cache behavior;
- rate limits and costs;
- license/redistribution rules for client packages.

Test a scratch secret reference through these three modes where supported:

1. node-brokered;
2. Hermes/harness-brokered;
3. destination-native.

Return a provider-neutral interface. Never use a vault token as the Control Room node or agent identity.

## 6. Identity, enrollment, authentication, and threat model

The existing identity dossier focuses mainly on Bitwarden and does not fully specify Control Room identity. Research current, lightweight options for:

- owner login and recovery;
- Cloudflare Access integration;
- node one-time enrollment;
- per-device keys and rotation;
- service accounts;
- Telegram identity binding;
- MCP client authentication;
- least-privilege scopes;
- revocation and quarantine;
- local enforcement if the central server is compromised.

Produce a threat model covering compromised Control Room server, compromised node, malicious adapter/skill, prompt injection, stolen device credential, replayed approval, and artifact tampering.

## 7. Monitoring integration proof

Verify Uptime Kuma using current official docs and a pinned version:

- authenticated checks against private endpoints;
- push/dead-man monitors;
- webhook or API delivery into a synthetic Control Room incident;
- deduplication, acknowledgment, recovery, and maintenance windows;
- Telegram ownership boundary;
- backup/export and upgrade behavior;
- license and public-distribution implications.

The result should treat Kuma as an external monitor behind an adapter, not as Control Room's authoritative service database.

## 8. Package-level license and reuse correction

Correct the existing matrix before public architecture decisions:

- reconcile the TL;DR count with the actual restrictive-component count;
- include exact packages, not only repository roots;
- cover Codex SDK/runtime packages;
- cover Claude TypeScript/Python SDKs and bundled runtime;
- cover Hermes dependencies and dashboard plugin dependencies actually reused;
- cover workflow-engine server and SDK packages;
- cover Bitwarden and 1Password client packages;
- cover selected node, database, queue, UI, and observability dependencies;
- record NOTICE and attribution obligations;
- distinguish internal use, redistribution, hosted service, and optional external integration;
- produce a machine-readable inventory suitable for an SBOM/license check.

## Required report format

For every finding include:

- official source URL;
- exact version, tag, or commit;
- observed/tested versus documented status;
- sanitized commands or code used;
- expected and actual result;
- license and distribution effect;
- Adopt / Wrap / Borrow / Build / Defer decision;
- unresolved risk and a concrete trigger for reevaluation.

Research is complete when the eight gates in `control-room/docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md` are satisfied. Stop there.
