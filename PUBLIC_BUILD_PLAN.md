# Public release plan and open contribution areas

Updated September 12, 2026. Humans, bots and mixed teams are welcome. Choose work by
your skills, platform and available time—not by a particular model or vendor.

## One product, configurable for everyone

One public core, one versioned release and one upgrade path. A maintainer's personal
installation uses the same artifact as everyone else's. Projects, worker registrations,
branding, templates, workflows, service connections and limits are configuration.
Credentials and private data stay outside the source repository. No private-only core
fork is required. Optional extensions use reviewed public interfaces and cannot grant
themselves permissions.

Prove customization by running the same artifact with two disposable configurations
and separate data stores, without source edits or rebuilding. Configuration exports
contain only documented non-secret portable fields. Upgrades preserve supported
configuration and identify incompatible extensions.

## Release outcome

A new user installs Control Room, connects two different supported harnesses, creates
project pages, assigns work, watches progress, reviews results and requests revisions.
Eligible work continues while reviews wait. Disconnects and restarts do not silently
repeat uncertain execution. Closing a project tab does not cancel its worker.

Hermes and Codex are the first integration targets. Other harness contributors are
welcome to propose adapters and reusable conformance scenarios. Extensible does not
mean every harness already works: publish tested versions and capability limitations.
Use existing upstream interfaces and selected components; explain any necessary custom
infrastructure. Do not patch an installed harness just to satisfy a synthetic contract.

This remains pre-alpha. A usable release candidate is the near-term target, not a
claim of completed live compatibility. Personal workflows, extra adapters, elaborate
scheduling and optional monitoring must not delay the first real mixed-harness loop.

## Where help makes the biggest difference

| Focus area | Difficulty / environment | Substantial outcome | Coordination |
| --- | --- | --- | --- |
| Project webpage and customization | Intermediate frontend; any OS | Project/worker pages, progress/results/revision, configurable templates, keyboard/mobile usability | [#10](../../issues/10); additional contributors welcome on reserved non-overlapping slices |
| Hermes integration | Advanced integration; Mac/Linux | Real upstream session/job mapping, progress/results and honest reconnect/capability behavior | [#8](../../issues/8), existing PR #14; coordinate before overlapping edits |
| Install, update and rollback | Intermediate/advanced tooling; Linux | Reproducible artifact, generic setup, integrity checks, documented upgrade/rollback | [#9](../../issues/9), existing PR #13; open for additional capacity with explicit handoff |
| Windows and cross-platform readiness | Intermediate platform work; Windows | Portable setup, line endings, worker constraints and browser acceptance | [#2](../../issues/2) |
| Release notices and attribution | Intermediate build tooling; any OS | Actual shipped dependency-instance/vendor coverage, original notices, packaging checks | [#11](../../issues/11), reuse useful PR #16 provenance |
| Core execution and recovery | Advanced backend; maintainer-coordinated | Admission, queue pickup, real Codex integration, durable identity and safe recovery | Propose an isolated implementation/test slice in [#12](../../issues/12); maintainer owns shared contracts |
| Independent review | Advanced in the relevant boundary | Concrete risk-focused review of execution, authorization, persistence or release candidate | Offer expertise in [#12](../../issues/12); no mandatory second review for routine UI/docs |
| Additional harness adapters | Intermediate/advanced integration | A supported upstream adapter plus conformance evidence, without another scheduler | Propose the harness and tested capabilities in [#12](../../issues/12); initial release prioritizes the first two |

These areas are not exclusive to a named bot or organization. Existing contributors
retain ownership of their active branches. Ask for a clearly separated part or a
recorded handoff; don't duplicate an existing PR. The maintainer confirms reservations
using a unique contributor/worker identifier when several bots share one GitHub login.

## Starting revision and branch transition

Public main currently contains the earlier source preview. More implementation is on
`codex/component-batch-4`, inspected at
`7b9d6782318d5d5266ea9e444cba8b67de65691b`. This documentation publication does not
merge or accept that implementation. Do not rebuild features already on that branch.

Existing PRs keep their recorded targets. Before any new implementation starts, the
maintainer records its immutable base SHA, exact target branch, owned paths and ready
dependencies. Pending baseline reconciliation, plan against the component tree above;
do not guess that main has the newer code. Once accepted work lands on main, new work
branches from it. Avoid long dependent PR stacks.

## Working together with less ceremony

Use [CONTRIBUTING.md](CONTRIBUTING.md), the
[public worker skill](skills/public-build-worker/SKILL.md) and
[public review skill](skills/public-build-review/SKILL.md).

- Choose a complete outcome—usually several hours of coherent work—not a single test.
- A maintainer-confirmed named assignment is the claim. A comment alone is not an
  atomic lock. Public assignments need no private V2 capsule/controller ceremony.
- Debug and repair ordinary code within scope without arbitrary retry counts. If
  repeated attempts produce no new evidence, report the blocker and take a different
  reserved independent item. Failed tests are not disqualification.
- Keep one active implementation and normally up to two submitted PRs. Continue
  independent assigned work while reviews happen; don't begin dependent changes early.
- Submit one concise PR: outcome, base/head, checks/results, untested limitations and
  upstream/license changes. No separate metadata commit or mandatory JSON report.
- Reviewers consolidate material findings. Cosmetic preferences are nonblocking.
  Re-review changed code and affected checks, not the entire project every round.
- Shared protocols, auth, credentials, migrations and final integration are maintainer
  decisions. Reserve shared paths early; contributors can propose improvements.
- Existing native/provider attempt limits remain binding. Ordinary debugging permission
  does not authorize deployment, credentials, persistent services or uncertain retries.
- Keep local commits and meaningful pushes. Public CI is enabled on standard hosted
  runners with read-only permissions and approval for external contributors. No
  scheduled builds, automatic deployment or privileged public-PR runners are enabled.

## Build and release sequence

1. Reconcile the public baseline and freeze small shared execution/configuration
   contracts. Request focused independent review of material boundaries.
2. Build webpage, adapters, packaging, notices and platform checks in parallel on
   reserved paths. Keep fake mode clearly labeled and connect the real product path.
3. Assemble one candidate SHA. Rehearse fresh install, two real harnesses, project
   isolation, result/revision, queued follow-up, lost reply, worker disconnect, server
   restart, denied access and bounded resource usage with disposable data.
4. Rehearse update/rollback and backup restoration into disposable storage. Verify the
   same release with two configurations and notices for its actual shipped contents.
5. Resolve material release findings, publish tested support/limitations and setup.
   If a real gate remains open, label the release a preview rather than claiming done.

Tests using fixtures are valuable but not native acceptance. Live tests need explicit
scope and the operator's own accounts; contributions grant no access to private hosts.
Track working user journeys and material blockers, not a percentage based on file or
test counts. [Issue #12](../../issues/12) is the coordination index. Posting an issue
does not itself wake or dispatch an external agent.
