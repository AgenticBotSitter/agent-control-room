# Overnight handoff — 2026-09-08

Runtime implementation checkpoint: `205e505` on `codex/idea-abs-workflows`;
`9b1b5c8` adds a test-fidelity correction and closing evidence. Later handoff
commits may change documentation only. This is local source and test evidence,
not a production-start authorization or a claim that GitHub contains this revision.
The original run ends at **12:40:58 UTC**; it is not extended by this handoff.

## What the local build now demonstrates

- The existing canonical queue stages an approved task and its exact signed lease
  together, commits one delivery intent, and sends them once on one connection.
  Cancellation or a lost response does not authorize a retry.
- A separate lease-aware node runtime requires both messages before start. It uses
  the existing verified current-policy reader over retained lease, owner approval,
  ceiling, local pause, key availability and capacity evidence. Early incomplete
  delivery does not consume the approved run.
- The existing HTTP connector drives this runtime to a saved result and pending
  owner review. No replacement connector, broker or polling stack was needed.
- Two independently approved tasks complete on the same stores with separate
  attempts, native IDs, results and review destinations. Their execution slot is
  released only by exact checked synthetic settlement, not by result receipt alone.
- Lost result delivery can be reconciled through explicit fixed-task recovery
  without another native start. This is not automatic unassigned recovery.
- Bounded restart inventories detect retained deliveries, runs, unknown attempts,
  unsettled work and active effect claims. Fresh lease-aware runtime construction
  refuses unresolved inventory. It is not a cross-process lock or server allocation.

These are disposable integration tests with synthetic trust, profile qualification,
key availability, provider, HTTP transport and cleanup-producer evidence. They do
not prove physical networking, live Hermes/Codex execution, real cleanup, PostgreSQL
concurrency, unattended fleet operation or production readiness. Fixed launcher
defaults remain unchanged; do not enable the lease feature in live configuration.

## Other completed source work during this run

The detailed log records deployment-only owner bootstrap, protected website/Idea
authoring profiles, stricter database checks, Idea/project lifecycle and navigation,
first-experiment task preparation, explicit multi-project planning, task-save/sign-in
recovery, and collector-to-research integration. These are source/local acceptance,
not configuration of the owner's production records or live provider setup.
See [the detailed overnight log](OVERNIGHT_BUILD_2026_09_08.md) and the focused
delivery documents it references. Do not sum test counts from overlapping reruns.

## What remains before daily unattended use

1. **Node lifecycle ownership:** ensure one lifecycle owner, reconstruct outstanding
   local and canonical work before fresh pickup, and connect the existing queue,
   connector, per-task runtimes, drain and exact recovery paths. Inventory alone
   cannot exclude concurrent processes or authorize another task.
2. **Qualified host cleanup:** obtain trustworthy evidence for the actual native
   run and its descendants. Existing synthetic cleanup proves the consumer, not a
   real Mac/Linux/Windows producer. Until then, retain uncertain capacity and do not
   install a restart loop that silently treats it as free.
3. **Operational packaging:** expose only the reviewed, combined lifecycle through
   protected node configuration, then separately qualify the selected hosts. Keep
   the existing fixed one-task/recovery path separate. Windows permissions remain
   an explicit unsupported gate, not an assumed Linux equivalent.
4. **Server deployment:** establish database persistence, dedicated roles/database,
   verified restore, supervisor/service account and real Access owner bootstrap.
   Then obtain explicit production-start authorization and verify the private site.
5. **Live product acceptance:** test real project monitoring, multi-agent Idea Lab
   and ABS research with selected agents and bounded owner-approved effects. A
   working website-only profile is not a working orchestration fleet.

## Johnny5: use the existing deployment package

Start with [consolidated deployment steps](JOHNNY5_DEPLOYMENT_NEXT_STEPS.md), not a
new installation recipe. The package already includes operator configuration,
database/role procedures, owner bootstrap, backup/restore and supervision templates.
Keep these procedures distinct from approval to execute them.

The latest owner-supplied VPS report—not independently rechecked in this local run—
still leaves dedicated database/roles unprovisioned, shared-primary persistence
unverified, no completed Control Room backup/restore, no approved installed service
and incomplete real Access owner verification. Existing sites must remain untouched.
Absent policy-level MFA override does not prove MFA is disabled: verify the saved
application-level authenticator requirement and inheritance.

Source inventory was regenerated locally without database contact or SQL execution:

| Profile | Migrations | Role files | Setup files | Inventory SHA-256 |
| --- | ---: | ---: | ---: | --- |
| website-only | 64 | 2 | 0 | `128c04d81b4a23b5269225aa3c6a2f434ab3b7c618ef25914ba094b21111762c` |
| idea-authoring | 64 | 3 | 1 | `8ff100249f86877b360b1f00c7b0e40a61765d4611d48f5d34c4645da007d8e2` |

After a separately approved future transfer, pin the exact transferred SHA. Do not
assume the moving branch or an old VPS checkout contains these local commits. Do
not copy Mac dependencies, profiles, credentials or runtime journals between hosts.

## What requires the owner or separately scoped operator authority

- Approval of a persistence/backup plan that protects applications sharing PostgreSQL.
- Exact dedicated database, roles, supervisor and service-account provisioning.
- A real Access login and verified owner subject; never substitute fixtures or guess
  identity, issuer, audience or MFA behavior.
- Explicit production start and ingress changes after the preceding gates pass.
- Separately bounded real-agent/profile/cleanup qualification on each supported host.
- A future GitHub transfer decision. This local stretch did not push, fetch, merge,
  create PRs or use Actions, and no usage reset was consumed.

## Preservation and verification

Unrelated private setup notes in `docs/BUILD_STATUS.md` and
`docs/WEBSITE_LOGIN_DELIVERY.md`, and the unrelated poster, remain uncommitted and
excluded from these implementation commits. No production service, database,
credential store, provider, DNS or tunnel was changed by this local work.

Final completed checks:

- Broad sequential native regression: **169 passed**, zero failures/skips.
- Full type-check and lint: passed.
- Fresh VPS compilation and four compiled startup/launcher checks: passed.
- Idea/ABS delivery command: all three stages passed (**112 / 22 / 242** cases).
- Policy/lease/runtime rerun after the test-fidelity correction: **36 passed**;
  final focused permission-change regression with the outside assertions: **4 passed**.
- Independent source reviews: concrete findings corrected and re-reviewed. These
  reviewers did not independently execute the tests or perform live qualification.

Stage/rerun totals overlap; do not add them into a unique test count. The final
test-only correction proves a valid narrower owner ceiling was actually adopted,
rather than treating an invalid fixture's setup exception as proof of revocation.
All check processes finished. Existing build deprecation/bundler warnings remain.
Exact outcomes and corrections are recorded in the detailed log. Do not publish raw
temporary logs; use the sanitized outcomes recorded there.
