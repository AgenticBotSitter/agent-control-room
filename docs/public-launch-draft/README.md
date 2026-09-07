# Public launch package — local staging index

These are unpublished drafts, not a runnable public distribution. Do not copy this
directory wholesale into a public repository. The owner must confirm the destination,
license, contacts and exact release scope; the candidate must pass privacy, attribution
and reproducibility review. Nothing here enables GitHub Actions or changes repository access.

## Proposed public files

| Destination | Local source | Before publication |
|---|---|---|
| README.md | [Project brief](../PUBLIC_PROJECT_BRIEF_DRAFT.md) | Confirm name, website/repository links and current release status |
| CONTRIBUTING.md | [Contributor guide](../PUBLIC_CONTRIBUTOR_GUIDE_DRAFT.md) | Confirm license/contribution policy and link verified setup |
| docs/ARCHITECTURE.md | [Architecture](ARCHITECTURE.md) | Technical review against the exact exported source |
| ROADMAP.md | [Roadmap](ROADMAP.md) | Confirm milestone evidence and turn scoped work into ready issues after source release |
| GOVERNANCE.md | [Governance](GOVERNANCE.md) | Owner approves policy and names accountable maintainers |
| SECURITY.md | [Security policy](SECURITY.md) | Establish and test a monitored private reporting channel |
| .github/PULL_REQUEST_TEMPLATE.md | [PR template](PULL_REQUEST_TEMPLATE.md) | Confirm contributor workflow |
| .github/ISSUE_TEMPLATE/work-item.md | [Work item](WORK_ITEM.md) | Maintainer fills all prerequisites before marking an issue ready |

The architecture and workflow drafts deliberately contain no personal infrastructure
defaults or private project names. They are not a license grant or security certification.

## Still needed, not silently filled in

- LICENSE and any contribution sign-off requirements: owner decision, then compatibility review.
- CODEOWNERS: actual consenting maintainer handles, not imaginary reviewers or bot identities.
- CODE_OF_CONDUCT and moderation contact: owner-approved behavior and enforcement policy.
- Review the drafted public roadmap against the [internal module map](../AGENT_CONTROL_ROOM_MODULE_ROADMAP.md),
  without publishing that internal source/path inventory verbatim.
- Verified quick start, development setup, supported-platform matrix and connector guides.
- Exact third-party notice package and resolved asset rights for the selected source tree.
- Private vulnerability reporting tested before soliciting security reports.
- Website browser acceptance and confirmed public links; [static implementation](../../public-site/README.md)
  and [copy](../PUBLIC_WEBSITE_COPY_DRAFT.md) are prepared locally.

An information-only announcement can precede the source release if approved separately.
It must not contain a nonworking installation button or claim that contributions can
already be built/tested from public source. Preserve the existing private repository
and history; assemble the source release separately with fresh history.
