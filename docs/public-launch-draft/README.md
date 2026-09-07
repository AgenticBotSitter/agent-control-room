# Public launch package — local staging index

This private directory contains both finalized release documents and optional policy
drafts. Do not copy it wholesale into a public repository. The exact 520-file candidate
is defined by `../research/public-candidate-release-inventory.json`, not by this directory.
Its source/content review is recorded; publication approval is still pending. Nothing
here enables GitHub Actions or changes repository access.

## Documents in the current release candidate

Original-code licensing is approved: use the full [LICENSE](LICENSE) and project
[NOTICE](NOTICE), now staged in the isolated candidate. Preserve separate upstream
licenses; this decision does not approve unfinished release checks.

| Destination | Local source | Before publication |
|---|---|---|
| README.md | [Project brief](../PUBLIC_PROJECT_BRIEF_DRAFT.md) | Finalized and independently reviewed at current candidate hash |
| CONTRIBUTING.md | [Contributor guide](../PUBLIC_CONTRIBUTOR_GUIDE_DRAFT.md) | Finalized; identifies maintainer, local checks and contact fallback |
| SETUP.md | [Candidate setup](SETUP.md) | macOS automated checks and one synthetic browser journey passed; other OS/accessibility/live-agent acceptance remains open |
| docs/ARCHITECTURE.md | [Architecture](ARCHITECTURE.md) | Reviewed; distinguishes historical evidence from public live qualification |
| ROADMAP.md | [Roadmap](ROADMAP.md) | Confirm milestone evidence and turn scoped work into ready issues after source release |
| WORK_PACKAGES.md | [Substantial contributor packages](WORK_PACKAGES.md) | Fill exact public base, prerequisites, allowed files and acceptance commands before issuing ready assignments |
| THIRD_PARTY.md | [Third-party scope](THIRD_PARTY.md) | Reviewed source-only scope; preserve all inventory-listed license/notice files |

## Additional drafts outside the candidate

GOVERNANCE.md, SECURITY.md, PULL_REQUEST_TEMPLATE.md and WORK_ITEM.md are not
included in the 520-file manifest. Do not upload them as incidental extras under
approval of that snapshot. The current CONTRIBUTING and WORK_PACKAGES documents
provide the initial contribution process; the three prepared issues in
`../PUBLIC_CONTRIBUTOR_ASSIGNMENTS.md` provide assignment details after publication.
Additional policies/templates need their own finalized content and review before use.

The architecture and workflow drafts deliberately contain no personal infrastructure
defaults or private project names. They are not a license grant or security certification.

## Separate decisions and future acceptance

- LICENSE/NOTICE: Apache-2.0 and original-code notices are included. Source-only
  third-party reconciliation is recorded; future binaries/containers require their
  own distribution review. No separate CLA or DCO is required for this preview.
- CODEOWNERS: actual consenting maintainer handles, not imaginary reviewers or bot identities.
- CODE_OF_CONDUCT and moderation contact: owner-approved behavior and enforcement policy.
- Windows/Linux setup and live connectors are explicitly unaccepted; they are future
  work, not prerequisites to claim a macOS-tested pre-alpha contributor preview.
- Private vulnerability reporting tested before soliciting security reports.
- Website browser acceptance and confirmed public links; [static implementation](../../public-site/README.md)
  and [copy](../PUBLIC_WEBSITE_COPY_DRAFT.md) are prepared locally.

An information-only announcement can precede the source release if approved separately.
It must not contain a nonworking installation button or claim that contributions can
already be built/tested from public source. Preserve the existing private repository
and history; assemble the source release in an isolated checkout of the public
repository, preserving its existing README history without importing private commits.
