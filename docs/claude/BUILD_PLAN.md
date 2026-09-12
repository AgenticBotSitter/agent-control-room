# Control Room build plan — reuse-first, execution-first

Author: Claude (Opus 5). Date: 2026-09-11. Baseline: `bc0a61a` on `codex/idea-abs-workflows`.

This plan does not replace Codex acceptance records in `docs/*_ACCEPTANCE.md`. It sequences
remaining work and names the model/effort for each stage. It authorizes no deployment,
credential, provider call or publication.

## Two rules that shape everything below

1. **Adopt services; build only authority.** Where a maintained project owns a
   responsibility (queues, backup, monitoring, identity, extraction, rendering), configure
   it. Control Room's irreducible custom core is canonical authority, Completion Gate,
   policy/approval, node protocol and project packs — that core is largely already written.
2. **Cross the execution line before widening.** 1,548 commits have produced no process
   that actually ran an agent. Exactly one file in `src/` imports `node:child_process`, and
   it is a keychain helper. Every module below Stage 3 is gated on Stage 2 succeeding.

## Stage 0 — Unblock the repository

`pnpm test` is red: 1,503 pass, 9 fail, exit 1. `main` is 764 commits behind. 87 PRs are
open, 84 stacked; PR #280 is the base of a 63-deep chain and is `MERGEABLE/CLEAN`.

| # | Work | Notes |
|---|---|---|
| 0.1 | Fix 3 architecture-guard failures | `#97` CI lane partition; `#280` native-HTTPS isolation breached by `private-native-configuration.ts` / `private-node-entry.ts` (commit `dd5f7bb9`); `#1377` private HTTP module ownership |
| 0.2 | Fix build-entry type coverage `#1198` | Missing generated preview declarations |
| 0.3 | Fix 5 fixture/handoff failures | `#1273/1275/1279/1280/1281` — one-use key handoff, uncertain-commit rollback, expired consumption |
| 0.4 | Reopen `CR14B_FIXTURE_PREPARATION_ACCEPTANCE.md` | Its accepted properties are red; the record has drifted from the tree |
| 0.5 | Merge #280, then walk the stack | Most are `CLEAN/SUCCESS`; #343 and #329 are red and go last |
| 0.6 | Restore CI; stop `[skip ci]` | 59 of the last 60 commits skipped CI; that is why 0.1–0.3 went unnoticed |

**Exit:** `pnpm test` green, `main` current, open PR count under 10.

**New rule from here:** branch every unit from `main`. No stacking.

## Stage 1 — Mechanical reuse landings

Independent of each other and of Stage 2. Good parallel work; low risk; already decided.

| Packet | Source | Decision |
|---|---|---|
| IP-01 | `jsonwebtoken` 9.0.3 behind the existing sync Access verifier | DR-05 |
| IP-04 | `node-postgres` 8.23.0 at the existing database port | DR-10 |
| — | `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 in the result panel | DR-11 |
| IP-02 | Readability 0.6.0 + jsdom for ABS article detail | DR-07 |
| — | `cron-parser` public seam for schedule matching | DR-09 |

Do not reopen these comparisons. Land them as code.

## Stage 2 — The execution line (critical path)

One real agent process, end to end, on one host. Everything else waits on this.

1. Implement the **Codex v1 seam** for real: pinned `codex exec --json` subprocess.
   `src/harness/codex-v1/` already has the decoder, manifest and compatibility gate; the
   isolated-child factory takes an injected spawner — supply a real one.
2. Preserve thread ID, cwd/worktree, sandbox, structured events, usage, final output,
   file changes and patch reference, per `CR3_PROTOCOLS_AND_EXTENSIONS.md`.
3. Drive it from the private Tasks page through the existing dispatch operation. Replace
   `"Task assignment is not connected or is unavailable."` with a real run.
4. Native Git detached worktree behind `CodexWorkspaceManagerV1` (DR-08).
5. Acceptance: one ordinary project → task → real process → real artifact → owner review →
   requested revision → second real run. No fixtures in that path.

**Exit:** the journey the closure checklist calls the cross-packet journey gate, run for real.

## Stage 3 — Ops by adoption

Each item deletes a custom subsystem rather than finishing it.

| Adopt | Replaces |
|---|---|
| Uptime Kuma (+ Beszel optional, disabled) | `CR10A_OPS_070` monitoring engine |
| pgBackRest | `CR10A_OPS_050_060` backup/recovery harness |
| Cloudflare Access (already configured) | Any custom auth server; do not reopen |
| pg-boss 12.30.0 (installed) | Custom scheduler internals |

Retain Control Room health/task authority. Metrics inform health; they never grant capacity
or permission.

## Stage 4 — Second and third harness

Proves `src/harness/sdk-v1` is a real extension point rather than a shape.

- **Claude Code v1:** pinned CLI `stream-json --verbose` subprocess. Nearly identical to
  Stage 2. Users install and license their own runtime; do not redistribute.
- **Hermes native:** upstream structured run/session/download interfaces (DR-17). No fork,
  no copied router, no new file-transfer engine.
- Run `runHarnessAdapterConformanceV1` against all three. No shared credentials across
  harnesses.
- OpenClaw stays a UI-pattern donor until a runtime need is named.

## Stage 5 — Continuous work and fleet

Continuous eligible pickup on pg-boss, concurrency, failure triage, batch review. Reconnect,
stale claims, cancellation, access revocation, drain/rollback. Browser refresh never starts a
second job. Package the connector for a second host.

## Stage 6 — Workflow modules

Now, and only now, on a proven task path.

1. **Lofi Wayfarer** — first real render. Add the FFmpeg/media-probe executor; make
   `mediaMaterialPresent` true. Unreal stays ineligible until a measured benchmark exists.
   YouTube upload remains a separately approved terminal effect.
2. **ABS news** — `control-center` `industry-curation.ts` scoring; article → real task.
3. **Idea Lab** — real multi-agent discussion → owner synthesis → promoted project.
4. **Content Blooms** — keep `source_scheduled`; Control Room requests preference only.

UI donors for the transcript/session surfaces: `hermes-desktop` Sessions screens and
`hermes-webui` run journal. These are undervalued in the current research and close RC3.

## Stage 7 — Public split

Assemble `packages/` under the eight `CR10B_PUB_000` public classes, default-deny. Publish
core + adapter SDK + conformance kit + synthetic reference adapters to
`AgenticBotSitter/agent-control-room`. Private packs (Wayfarer, Blooms, ABS) plug into the
same published seams a third party would use. License/notice work is DR-03/DR-04.

## Research program

Freeze the 17 decisions in `reuse-comparisons/decision-register.md`. The remaining 24
`comparison_incomplete` gates close as **implementation evidence**, not new dossiers — which
is what the closure checklist's own cross-packet journey gate already asks for. Do not open a
new comparison unless a required acceptance test actually fails.

## Update rule

At the end of every completed or blocked piece of work, state:

1. what was delivered and how it was verified;
2. what is next;
3. the exact model and reasoning effort to set for it, and one line of why.

This mirrors the existing rule in `BUILD_STATUS.md`. Exactly one next block at a time.

## Stage 0.2 boundary decisions

Two architecture guards failed because committed code crossed a declared boundary. In both
cases the guard was stale rather than the code wrong, but the repair preserved the property
each guard existed to protect instead of widening its allowlist.

**Native HTTPS isolation (`tests/hermes-native-isolation.test.ts`).** The guard was written
`6005cb1b` (2026-09-06); the packaged node launcher `a89a8d88` and its resource assembly
`dd5f7bb9` landed 2026-09-08. A shipped node needs exactly one place that assembles durable
resources, and `src/node-bridge/private-native-configuration.ts` is it, re-exported through
`private-node-entry.ts` — the declared `vite.vps.config.ts` entry compiled to
`dist-vps/server/nodeConnector.js` and loaded by `scripts/run-private-node.mjs`.

The guard now separates three roles instead of two: **owners** (within
`src/harness/hermes-native-v1/`, only `https-transport.ts` imports `node:https`/`node:tls`/
`node:dns` — this is a harness-scoped property, not a repo-wide one; six files elsewhere in
`src/` import those modules today), **consumers** (`native-connector.ts` and
`native-http-host.ts`, type-only, and now explicitly forbidden from calling
`createNativeHttpsTransport` or constructing `SqliteNativeRunJournal`), and one pinned
**composition root**. The root is tied to the vps build entry, so a second assembly point
cannot appear without also changing the build definition. Verified negatively: adding a
third file that references the runtime fails the guard.

**Private HTTP ownership (`tests/web-private-serving.test.ts`).** `src/vendor/control-center/
pinned-fetch.ts` — vendored from `mreflow/control-center` for ABS source collection — owns
`node:http` for *outbound* fetching. That is a different responsibility from *inbound*
serving; the guard conflated them because nothing else in `src/` previously imported
`node:http`. It now names each role and admits the outbound client only while it stays a
client: no `.listen(`/`createServer(`/`process.env`, plus behavioural assertions that drive
`resolvePublicUrl` with an injected lookup — URL credentials, `localhost`, `.local`, non-HTTP
schemes and seven private/loopback/link-local addresses must all be refused, and a public host
must resolve. Independent review found the first version pinned identifier spelling rather than
behaviour: neutering the credential throw, or narrowing the address guard to IPv4, both kept it
green. Verified negatively — each of those weakenings now fails.

**Typecheck scope.** `tsconfig.json` included `**/*.ts` with only `node_modules` excluded, so
`research/` gated the production typecheck; `research` is now excluded. That code is mostly
tracked, not scratch — 15 of 23 TypeScript files under `research/` are in git, and they import
deep into `src/`, making them the closest thing to consumer-side type tests for those APIs.
Excluding them alone would have left them typechecked nowhere, so `tsconfig.research.json` and
a non-blocking `pnpm check:research` retain the signal (11 pre-existing errors, unblocked).
`tsconfig.vps.json` was missing five build entries — idea authoring, owner bootstrap, owner
review, task database check and the node connector entry — which were therefore never
standalone typechecked. All five now are, and pass.

## Stage 0.3 findings — schema drift, not broken custody

All five failures had one cause. `private-fixture-preparation.ts` refused to seed because
`ensure(tables.length === 138)` no longer matched the schema: migrations `0055`–`0064` (ten
ABS news migrations) added seven tables, taking the count to **145**. Measured by applying
`db/migrations` to PGlite at both boundaries — 138 at `0001-0054`, 145 at HEAD.

The custody properties were never broken. "Uncertain commit never returns keys", "expired
handoff is consumed without returning material" and the rest failed only because preparation
stopped before reaching them. Two neighbouring safety tests — full-transaction rollback
exposing no handoff, and fixture builders returning no signing private key — passed
throughout. `CR14B_FIXTURE_PREPARATION_ACCEPTANCE.md` does not need reopening on the merits;
its evidence was masked by a stale constant, not contradicted.

**Why only this constant drifted.** `tests/audit-required-hashes.test.mjs` pins
`privateWebSchemaDigest` against actually applied migrations, so the digest was regenerated
for `0064`. The table count had no such pin. The repair removes that asymmetry: the count now
lives beside the digest in `private-database-preflight.ts` as `privateWebTableCount`, under
one comment saying to regenerate them together, and the same test pins both. Verified
negatively — restoring `138` fails the pin.

A second constant on the same axis was also stale: the preparation packet declared
`migrationsApplied: z.literal("0001-0054")` while the digest and count describe `0001-0064`,
so a valid packet asserted a migration range that could not produce the schema it was then
checked against. Both now read `0001-0064`. Packets issued against the older schema are
correctly rejected; that is the fail-closed behaviour, not a regression.

Independent review caught that the first fix reproduced the very bug it diagnosed one constant
over: `migrationsApplied` moved from one hand-maintained literal to another with no pin.
`privateWebMigrationRange` now sits beside the digest and count, `z.literal` consumes it, and
the same test derives the range from the migration filenames actually applied and requires a
gapless sequence. Verified by adding a synthetic `0065`: the pin fails.

Note for later readers: five CR14C acceptance docs (capacity-release, quality-coordinator,
revision-planning, revised-result, owner-revision) cite "migrations 0001-0054, 138 tables" as
their evidence line. That boundary is superseded, not wrong — do not read 138 as current.

## Deferred from Stage 0 review → Stage 6

**ABS collection moves onto the accepted bridge.** `src/project-adapters/abs-news/v1/
public-reader.ts` already performs ABS outbound reads through `node-policy/v1/
network-target-guard` (`preparePinnedHttpsConnection` / `verifyPinnedTlsPeer`) — the repo's own
reviewed DNS-pinning and TLS-peer path, HTTPS-only with `rejectUnauthorized`, `minVersion:
TLSv1.2`, pinned ALPN and explicit `checkServerIdentity`. The vendored `pinned-fetch.ts`
duplicates that responsibility with weaker inline checks and permits plain `http:`, and it is
the sole reason `node:http` enters `src/` at all.

Blast radius is small: every consumer imports only `type { PinnedFetchDependencies }`, and the
only runtime consumer is `safe-fetch.ts`. When ABS collection moves to `public-reader`,
`pinned-fetch.ts` and `safe-fetch.ts` are deleted and the serving guard reverts to a single
owner, removing the `http:`-allowed path. Admitted now only to reach a green Stage 0.

Behavioural coverage for the vendored client lives in `control-center-fetch.test.ts`, which
runs in `test:idea-abs` — a different lane from `web-private-serving.test.ts`, which runs in
`test`.
