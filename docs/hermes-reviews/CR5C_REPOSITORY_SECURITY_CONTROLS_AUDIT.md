# CR-5C repository security controls and CI evidence audit

**Status:** Complete 2026-08-23
**Worker route:** Hermes / macOS Mac mini / provisional qualification — repository audit packet, report-only.
**Purpose:** Evidence-based audit of the repository's **existing** security and review controls so the private-build workflow does not silently depend on assumptions. Nothing was changed: no GitHub settings, no Actions files, no dependencies.
**Evidence basis:** Local checkout @ `489cd6d`; read-only GitHub REST API calls with the worker's stored git credential (repo-scoped); `git log` metadata. Claim classes: **observed** (directly verified), **unavailable** (cannot be verified from this context), **recommendation**.

## 1. Evidence table

| Control area | Status | Evidence | Class | Gap label |
|---|---|---|---|---|
| Branch protection / rulesets | **Unverifiable from local checkout; API returns 403** on `GET /branches/main/protection` and rulesets ("Upgrade to GitHub Pro or make this repository public to enable this feature.") | API responses captured 2026-08-23 | unavailable (plan-limited) | **repository configuration** — see §3 manual checks |
| Direct-main-push protection | Not enforceable via API on this plan | Same 403; playbook states the procedural rule applies regardless (`docs/HERMES_DELEGATION_PLAYBOOK.md:29`) | unavailable + observed doc | **process** |
| Review requirement before merge | Procedurally defined (playbook lifecycle §work-packet, build-plan §review policy) but technically unenforced on this plan | `HERMES_DELEGATION_PLAYBOOK.md:36-39`, `CR3_BUILD_PLAN.md:87-96` | documented | **process** — holds only while workers honor "do not merge own PR" |
| Status checks | No CI exists to gate | `.github/workflows/` absent (**observed**: directory does not exist) | observed | **code/future CR control** |
| Issue templates | Present and strict | `.github/ISSUE_TEMPLATE/hermes-work-packet.yml` — required fields incl. CR block, worker route, task class, risk, allowed paths (**observed**) | observed | none |
| PR template | Present, matches what workers have been producing | `.github/pull_request_template.md`: work packet / result / validation / safety checkboxes / reviewer disposition (**observed**, exercised by PRs #19–#22) | observed | none |
| CODEOWNERS | **Absent** | `ls CODEOWNERS .github/CODEOWNERS` → not found | observed | **repository configuration** — low urgency while team = owner + Codex reviews, becomes material if more collaborators arrive |
| Dependency update policy | None automated; versions pinned in lockfile | No dependabot/renovate config (**observed**); `pnpm-lock.yaml` present with pinned resolutions; ADR-020 mandates staged upgrades (`docs/CR3_DECISION_LOG.md:238-248`) | observed + documented | **future CR control** (CR-10A ops) |
| Secret scanning guidance | Absent from repo docs | grep for secret-scanning/push-protection/gitleaks across `docs/`, `README.md` → no hits | observed | **process** — recommendation below |
| CI reproducibility | Tests are deterministic and locally reproducible: `pnpm install --frozen-lockfile && pnpm test && pnpm run check && pnpm run db:verify` all pass (27→66-test suites per block status; verified again this session on `489cd6d`) | `package.json` scripts (**observed**); `docs/BUILD_STATUS.md` records per-block validation counts | observed | **code/future CR control** — nothing runs them automatically on push |
| Artifact/log redaction | Strong at application level | Central secret-material guard applied at persistence/transport boundaries (`src/security/redaction.ts:38-41`; call sites in stores/journal/protocol) | observed | none at code level; no CI-log redaction policy exists because no CI exists |
| Release/publication separation | Defined architecturally, not yet operational | Build-plan CR-9/CR-10 gates; no publish script in `package.json` (**observed**) | documented | **future CR control** |
| Worker attribution | Required procedurally; inconsistently enforceable | Playbook requires worker/machine/harness/model per commit+PR (`HERMES_DELEGATION_PLAYBOOK.md:28`). Observed practice: PR bodies carry it; commits use the local git identity (e.g. "Alastair Fraser <alastairfraser@Alastairs-Mac-mini.local>") rather than per-worker identities | observed + gap | **process** — shared-identity workaround is explicitly allowed temporarily by the playbook itself |

## 2. Observed strengths worth keeping

1. Work-packet discipline is genuinely strict — issue template forces allowed paths/risk/scope before work starts; every returned PR this week (#3, #4, #19–#22) followed it.
2. Application-layer redaction is defense-in-depth at real boundaries, not a single choke point.
3. Test suites are deterministic, fast (~seconds), and cover adversarial cases (46-test CR-4Q suite; replay/poison/backpressure cases).
4. The playbook already anticipates its own replacement by Control Room-native authority (playbook §final section).

## 3. Manual checks only the owner can run (GitHub-side)

1. **Branch protection visibility:** Settings → Branches → check whether `main` has any protection/ruleset. On the free/private plan GitHub cannot expose this via API — record the answer in `docs/BUILD_STATUS.md`.
2. **Secret scanning / push protection:** Settings → Code security → enable push protection if the plan allows it (free for private repos since 2024 — may be available even where rulesets are not).
3. **Actions availability:** confirm whether private-repo Actions minutes are available/enabled; decides whether a minimal CI workflow is even possible.
4. **Collaborator audit:** Settings → Collaborators — verify exactly the intended identities have access (currently expected: owner + worker credentials).
5. **Audit log spot-check:** Settings → Audit log — filter `git.push` to `main` and confirm no direct pushes bypassing PRs.

## 4. Recommendations (for Codex/Sol to decide whether/when to enact)

| # | Recommendation | Label | Priority |
|---|---|---|---|
| R1 | Add one minimal GitHub Actions workflow running `install --frozen-lockfile`, `test`, `check`, `db:verify` on every PR — converts procedural review into gated evidence, and is the single highest-leverage change available | future CR control | High |
| R2 | Enable push protection / secret scanning if plan permits (owner manual step §3.2) | repository configuration | High, zero-cost |
| R3 | Add CODEOWNERS assigning `docs/hermes-reviews/` and `src/security/**` to the owner account so required reviewers are explicit when the plan supports it | repository configuration | Medium |
| R4 | Write a short secrets-hygiene section (what never enters the repo, canary testing cadence, incident response for an accidental commit) — the delegation playbook covers worker conduct but not repo-side scanning/response | process | Medium |
| R5 | Per-worker git identities or commit trailers (`Worker-ID:`/`Machine-ID:` headers) so attribution survives into `git log` without relying on PR-body prose | process | Medium |
| R6 | Dependabot or scheduled `pnpm outdated` report feeding the ADR-020 staged-upgrade flow once CI exists (R1) | future CR control | Low until CR-10A |

## 5. Explicitly out of scope / not performed

No settings changed, no workflows created, no dependency updates, no external vulnerability scans, no secret uploads, no network calls beyond read-only GitHub API and normal git metadata. All findings above are reproducible by re-running the same read-only queries.

## Method note

Local checkout inspected @ `489cd6d` (`.github/`, root config files, `docs/`, lockfile). API evidence gathered via `GET /repos/MarvinAi5/control-room{,/branches/main/protection,/rulesets}` with the worker's stored credential; response codes quoted verbatim. No tokens, credentialed URLs, or private infrastructure details are included in this report.
