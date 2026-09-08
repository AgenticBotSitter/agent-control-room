# F3: project/session presentation comparison — bounded first experiment

2026-09-08. Baseline branch `codex/idea-abs-workflows`, `44f9064`.
Scope A6/A7/B5/C1/C2: presentation and identity, not execution engines.
**Partial evidence, not a completed F3 decision.** No application code changed.

**Mounted follow-up now available:** [F3 mounted comparison](f3-mounted-fit.md)
supersedes the missing-browser/protected-API statements below only for its exact
small candidate scope. Broader conversation, mobile/CSS and native-session gates
remain. This first-experiment record is preserved rather than rewriting history.

## Pinned candidates and exact exercised scope

- Hermes Desktop `3f744975f818bbb40ed029e6b3022cd0c5ad7a24`:
  `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx` (108 lines),
  `chatRuns.ts` (178 lines). Actual component body statically rendered by React;
  actual transition functions transpiled by TypeScript and executed. Type-only
  imports erase. Icons, animation, avatar and translation are substituted inert
  dependencies, explicitly **not** qualified. No Electron runtime loaded.
- Hermes WebUI `e168b67e4278df618d1cab61fdb3a8dc55b29a81`:
  `static/sessions.js` (9,520 lines), `static/workspace.js` (1,549 lines).
  Six exact top-level function AST nodes from sessions.js execute in Node VM:
  `_profileMatchesActiveProfile`, `_sessionEventProfilesMatch`,
  `_isSessionLocallyStreaming`, `_isSessionEffectivelyStreaming`,
  `_hasPendingUserMessageSignal`, `_isServerIdleSessionRow`. The profile functions
  loaded but were not asserted; only stream/idle checks count as exercised.
  Surrounding browser/global session state is synthetic. No replacement imitation
  of candidate logic; no Python server or network invocation.
- Existing Control Room: `private-app/app/workspace.tsx`,
  `app/components/project-catalog-navigation.tsx`, existing project catalog/session
  authority tests and workspace static-render tests.
- Herdr v0.9.0 remains the separately tested terminal/observation backend candidate;
  reuse [existing binary/adapter evidence](../HERDR_ADAPTER_EVALUATION.md). It is
  complementary, not a competing React catalog or an execution-approval service.
- Studio is not requalified here; retain its licensing screen from the map. A BSL
  repository cannot be treated as MIT UI source. F9 must disposition exact desired
  files before any copying. This is not a claim every F3 candidate was exercised.

## Code-path findings that change the integration decision

| Responsibility | Desktop actual behavior | WebUI actual behavior | Control Room fit |
| --- | --- | --- | --- |
| Close view vs stop work | Bar only invokes passed `onClose`; its type comment says close **and stop**. Our supplied callback leaves loading run unchanged | Full session/menu/stream closure depends on large global shell; not mounted | Reuse bar body only with view-only callback, no cancellation import. Current browser-tab/project lifecycle remain separate |
| Identity and duplicates | `findRunByLocation` matches connection/profile/session tuple; `openSessionRunTransition` alone appends duplicate native-session view; `loadingSessionIds` returns raw IDs only | Tested stream helpers match raw `session_id`, ignoring machine/project | Composite authoritative project + worker + session identity required; never import raw-ID loading set unmodified |
| Offline/stale | Bar receives loading boolean only, no stale/unknown vocabulary | Actual helper ignores background stale INFLIGHT entries and honors server streaming/pending flags | Borrow WebUI anti-stuck-indicator case; add timestamp/observation status at our boundary, not infer completion |
| Logout isolation | Empty controlled props remove labels; full app cache/IPC not tested | Clearing S.session stops local busy marker; localStorage keys persist in shell | Neither standalone test proves logout. Retain current protected read clearing and test mounted scope generation/cache teardown |
| Project grouping | Existing E04 sidebar groups by folder and depends on `window.hermesAPI` | session lineage/date grouping operates in global session list, not protected project-ID catalog | Keep our catalog authority/cursor API; group only authorized rows by stable project ID |
| Keyboard | Pure cycling/ordinal helpers work; rendered `role=tab` div lacks tabIndex | Source has J/K navigation; upstream selected test asserts source strings | Desktop bar needs keyboard/semantic adaptation; WebUI keyboard cannot be accepted from source-only checks |

These are local seam mismatches, **not whole-product bugs**: upstream callers may
deduplicate or constrain one connection/profile. Control Room combines machines and
projects, so those assumptions must be explicit in our adapter.

`private-app/app/workspace.tsx` already fences responses with a generation and live
flag, clears project/catalog state on rejected reads, polls read-only every 30 seconds
when visible, and removes timers/focus listeners on cleanup. Refresh never resubmits
writes. Replacing this with WebUI's generic `api` helper would import default network
retries, credentials/include and its login redirect convention. That helper is not
an established safe replacement for our uncertain-write handling or Access boundary.

## Executed evidence and limitations

Command:

```sh
node research/reuse-comparisons/f3-exercise.mjs /private/tmp/control-room-f3.REACQUIRED
node --import tsx --test tests/project-workspace-navigation.test.tsx tests/project-workspace-catalog-session.test.ts
```

Reacquire exact named source files from the acquisition manifest; harness validates
SHA256 before executing. No installs, external fetches or services inside harness.

- Candidate harness: **8 checks passed**. Two preserve negative integration findings
  (duplicate transition and cross-machine ID collapse). Two-project fixture uses same
  native session ID on two synthetic machines and different project/run keys.
- Existing Control Room tests: **14 passed**, 0 failed. Ten exercise synthetic
  protected catalog/session authority, four static workspace rendering/navigation.
  These are baseline evidence, not a candidate-to-protected-API integration test.
- Candidate harness measured RSS 150,864 KiB (Node + TypeScript + React + VM), elapsed
  command approximately 0.14 seconds. **Not** browser/agent/application RAM. No fair
  candidate-specific resource comparison or mobile rendering measurement yet.
- Upstream tests inspected: Desktop `ActiveSessionsBar.test.tsx` (three rendering
  cases, translation/avatar mocked), `chatRuns.test.ts` transition cases sampled;
  WebUI `tests/test_3845_keyboard_session_nav.py` source-string tests and first
  100 lines of `tests/test_cross_session_message_load_isolation.py`, which also
  contains extracted-function Node runtime cases. Upstream tests **not run**.
- No browser mount, protected API crossing, real reconnect/restart of either UI,
  full logout, keyboard interaction, mobile geometry or complete conversation
  rendering. These remain decisive local E3 comparisons, not deferred E4 excuses.

Evidence level: selected Desktop component/state and selected WebUI status functions
E2; current source paths E1; no E3 candidate integration. Synthetic negative findings
are reproducible, not proof of native Hermes/Codex behavior.

### Independent review disposition

[Source-only independent review](f3-independent-review.md) found no blocking defect
in the stated partial E2 scope and identified three hardening points:

- The prior eight-check run counted tabs and checked absence of Project A after
  clearing props, but did **not** positively assert rendered Project A/Project B
  labels. Explicit positive assertions are now added to the harness. They remain
  **unexecuted**, because the pinned source root was already cleaned. The existing
  eight-check receipt must not be presented as a pass for these added assertions.
  Run them during the next authorized E3 reacquisition, not a ceremonial redownload.
- `moduleFrom` exposes ordinary require. Its VM/hash checks are **not a security
  sandbox**; the one-second VM timeout bounds initialization, not later callbacks.
  Every changed source pin and dependency requires review before execution. The
  harness now says this explicitly; no stronger isolation is claimed.
- Direct `bar.type` and child-position indexing are intentionally pinned probes,
  not stable UI interaction tests. The mounted comparison must query accessible
  controls and dispatch normal user events instead of carrying these assumptions.

Only syntax/diff validation was performed after these review edits; no new candidate
execution or download occurred. F3 and mounted comparison remain incomplete.

## Licensing / dependencies / maintenance

Both exact root licenses read: Desktop MIT copyright 2026 github.com/fathah;
WebUI MIT copyright 2025 Hermes Web UI Contributors. Preserve MIT text/attribution
with any extracted/adapted source. Proposed pure helpers add no runtime dependency.
Desktop bar could use existing React, with existing Control Room icons/loading/text
instead of importing its decorative dependency tree. Full Desktop would bring
Electron/IPC/settings/cache and a second shell; not licensed/qualified by this subset.
Full WebUI would bring Python backend/global browser API assumptions; no package or
transitive license audit performed for that larger import. Acquisition hashes record
exact selected assets; no third-party source is shipped by this report/harness.

Git trees confirm both candidates carry numerous session regression tests. Pins are
the prior research pins, not claimed latest releases or a maintenance-health verdict.
Review upstream changes before eventual import; keep focused seam tests as upgrade
gates. Carrying an entire shell fork has materially larger unmeasured cost than
extracting the controlled component/helper boundaries. Security/release issue trend
review remains incomplete and is not converted into an invented score.

## Integration cost and conditional disposition

| Option | Specific work retained/adapted | Estimate, not implemented measurement | Conditional decision |
| --- | --- | --- | --- |
| Retain current catalog/browser project views | Retain workspace.tsx, project-catalog-navigation.tsx and protected project client/authority | Zero migration, zero new service; open-session strip still missing | Retain authority/navigation baseline |
| Desktop small presentation + helpers | Adapt 108-line bar and selected subset of 178-line helpers; remove decorative imports, stop contract, raw-ID assumptions; add accessible controls/stale status | ~100–250 adapter/presentation lines plus tests, 0 service, 0 schema migration; estimate ±2x pending mount | Leading narrow strip candidate, **not finalized winner** |
| WebUI small attention/recovery helpers | Extract ~20–60 relevant status lines; translate global S to explicit inputs with project/worker identity | ~40–120 bridge lines plus tests, 0 service; no direct safe copying of whole api helper | Complement Desktop/current UI, preserve stale-stream repair scenarios |
| Full WebUI shell | Rewrite DOM/global state/API route mapping and Python ownership assumptions; 11,069 inspected session/workspace lines alone | No credible estimate yet; large fork/second state authority risk | Do not select for drop-in UI; compare specific narrow modules instead |
| Full Desktop shell | Replace window.hermesAPI contexts, connection/profile identity, cache/settings and Electron effects | No credible estimate yet; avoid introducing Electron server/service for web UI | Do not select full-shell transplant |

**Existing production lines eligible for deletion today: 0.** There is no mounted
conversation/session strip being replaced. Benefits are avoiding new UI/state helpers,
not deleting security/runtime machinery. Rollback of a future optional strip should
remove its route/component/ephemeral state and leave current project URLs intact;
never close agent sessions to roll back presentation.

No weighted winner score yet: resource and browser-fit dimensions remain unknown.
Known source dependency differences justify narrowing candidates, not declaring F3 done.

## Next decisive experiment (still in authorized local comparison scope)

Mount the actual Desktop bar adaptation and a narrow WebUI list/attention adaptation
beside current project navigation against one disposable protected project read seam.
Use identical two-project/two-machine fixture, repeated native IDs, an expired owner
session, reversed/late responses and lost/recovered transport. Measure callback effects,
keyboard/tab order and narrow viewport; verify closed views leave run records intact
and logout removes titles/transcripts without later response resurrection. Exercise
WebUI lineage/grouping only where its model actually corresponds to our transcript
continuations; do not conflate it with project identity. Use existing browser tools or
an isolated script-disabled DOM test dependency if needed, with acquisition log.
Independent review should challenge Desktop against this strongest narrow WebUI
alternative. That mounted comparison must close before F3 is declared complete.
