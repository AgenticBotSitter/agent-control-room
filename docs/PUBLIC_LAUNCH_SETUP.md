# Public launch setup — owner checklist

2026-09-06. Local planning document, not publication approval. Existing private
repository, history, deployment and credentials stay private. Account names, domain,
license and contact remain owner decisions. No account, repository or DNS changes made.

## Recommended structure

Keep the existing personal GitHub login. Create a separate **GitHub Free organization**
for the project, with that login as its owner. Proposed display name: Agent Control Room.
Try `AgentControlRoom` as the handle; availability has not been checked. If unavailable,
choose a recognizable variation, for example `agent-control-room-community`.
Proposed product repository: `agent-control-room` under the new organization.

The organization is a shared project home, not another login or a legal incorporation.
Membership does not automatically transfer or publish personally owned repositories.
There is no need to buy another paid plan for this public-project starting point.
The owner's existing paid subscription and exact billing tier have not been inspected.
See [GitHub account types](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts).

## Owner actions

1. Sign into the existing GitHub account. Keep account recovery codes in the password
   manager and enable two-factor authentication if not already enabled.
2. Profile picture → Settings → Organizations → New organization. Choose GitHub Free,
   enter the chosen organization handle and an email address you control. Complete any
   verification steps yourself. Do not invite all contributors as owners.
3. Either send the organization URL back, or also create an empty repository:
   select New repository, set Owner to the new organization, name it
   `agent-control-room`, and choose Public. Public here means an empty new destination,
   not permission to upload the private project.
4. Do not select a template, import the old repository, upload the current folder, or
   change the private repository's visibility. Leave README, .gitignore and license
   initialization off so the reviewed launch package can provide them together.
5. Leave Actions disabled initially. Public CI needs a reviewed configuration before
   activation; do not attach personal machines or the VPS as public-PR runners.

Official instructions: [organization creation](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch),
[repository creation](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository).

## Send back only non-secret details

- Organization URL and repository URL, if created.
- Confirmed product name and preferred public maintainer name/credit.
- Confirmed welcome-page domain: `agentcontrolroom.xyz`. The owner clarified that
  `.com` was taken and is not owned. DNS/HTTPS configuration still needs verification.
- Domain registrar and DNS provider names. Do not send passwords, DNS tokens or keys.
- Confirmed general project email: `Alastair@agenticbotsitter.com`.
- Original-code license decision; the Apache-2.0 recommendation is not yet approval.

Use existing local GitHub authentication if it grants the needed organization access.
If another permission is required, complete GitHub's browser authorization yourself.
Never paste access tokens, passwords, recovery codes, authentication codes or private
SSH keys into chat. Domain access is needed only when deployment/DNS is separately approved.

## Launch package to finish locally

The [local staging index](public-launch-draft/README.md) now maps the proposed public
files to their draft sources, with explicit remaining decisions. Architecture,
governance, security-reporting, PR and ready-work templates are drafted there. They
are not installed as active repository policies or copied to `.github`.

Reuse `PUBLIC_PROJECT_BRIEF_DRAFT.md`, `PUBLIC_CONTRIBUTOR_GUIDE_DRAFT.md` and
`AGENT_CONTROL_ROOM_MODULE_ROADMAP.md`; do not publish internal build logs wholesale.

| Public deliverable | Contents / remaining work |
|---|---|
| README.md | Purpose, honest pre-alpha status, real capabilities versus roadmap, website and contribution links |
| CONTRIBUTING.md and contributor instructions | Clean setup, own fork/branch, platform prerequisites, tests, reuse/license rules, handoff and review process |
| ROADMAP.md and architecture overview | Core versus optional modules, dependencies, concrete completion criteria; generic examples only |
| SECURITY.md | Confirmed private reporting channel and supported-version status; no public exploit/secret reports |
| GOVERNANCE.md, CODEOWNERS and conduct policy | Owner accountability, qualified reviewer responsibilities, conflicts and moderation contact; actual GitHub handles required |
| Issue forms and PR template | Bugs, feature proposals and ready work with platform, prerequisites, scope, tests and upstream attribution |
| LICENSE and dependency notices | Owner-selected license for eligible original code, preserved upstream notices, resolved asset rights |
| Setup and connector guides | Verified installation commands and explicit platform support, no copied credentials or private host coordinates |
| Public website | Project explanation, honest status, how to help, GitHub link, optional founder/site credit; no private-app links |

Before source publication: assemble a fresh-history reviewed candidate in a separate
checkout, complete privacy/rights and clean-install/demo checks, obtain independent
review and owner approval naming the exact candidate and destination. Do not connect
a public push remote to the private checkout or mirror private branches.

An earlier **announcement-only** release can publish approved project information and
roadmap without pretending the runnable code is available. It requires its own approval.

## Repository settings after the first reviewed content

Recommend required 2FA for organization members, minimal member permissions, Issues
and Discussions for collaboration, private vulnerability reporting, and a main-branch
ruleset requiring PRs and blocking force pushes/deletion. Configure reviewer requirements
to match actual maintainers: one human using several agents is not several GitHub reviewers.
Add required checks only after those exact checks exist and have been exercised.

GitHub Free supports public-repository rulesets and organization 2FA requirements.
See [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[organization 2FA](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization),
and [private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

Standard GitHub-hosted runners in public repositories have free Actions usage; this does
not make every runner, storage or adjacent service free. It does not lift the current
no-Actions instruction. Review limits, retention and fork permissions before enabling CI.
See [Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage).
