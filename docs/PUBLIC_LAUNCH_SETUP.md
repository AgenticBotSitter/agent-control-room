# Public contributor launch — remaining work

This is the current launch checklist. Historical account-creation and undecided-license
instructions are superseded by the confirmed decisions below. It is not blanket
publication, deployment or security-setting approval.

## Confirmed and completed

- Organization: AgenticBotSitter. Do not create another account or organization.
- Public product repository: https://github.com/AgenticBotSitter/agent-control-room
- Private website repository: https://github.com/AgenticBotSitter/agent-control-room-website
- Public welcome-page domain: https://agentcontrolroom.xyz
- Maintainer: Alastair Fraser; GitHub account with verified administrator access: MarvinAi5.
- Main website: https://agenticbotsitter.com
- Contact: Alastair@agenticbotsitter.com
- Original-code license: Apache-2.0 with the approved project NOTICE.
- Public introduction uploaded at `f699fa0`; private website handoff at `f03ca15`.
- Actions disabled in both repositories. No new CI workflow is part of this release.
- Owner reports Johnny5 is hosting the website. Live DNS/HTTPS and site content have
  not been independently verified here.

Do not ask the owner to repeat these decisions. Never publish Cloudflare dashboard
links, private Git history, host-specific account metadata or private project data.

## What contributors can access today

The public repository currently has only its introduction README, with no application
source or ready work issues. It is shareable as an announcement, not yet as a runnable
contributor release. The separate website repository does not supply application source.

## Finish the source release

1. **Freeze and inspect the exact candidate.** The private evidence file
   [release inventory](research/public-candidate-release-inventory.json) identifies
   all 520 current source/document files and their hashes, excluding installed
   dependencies and build output. Nine content-review receipts match 72
   files byte-for-byte. This is evidence coverage, not a claim that the other 448
   files were never inspected or that all matched files have security clearance.
   Reuse other bounded reviews where their scope and exact bytes can be established;
   inspect the remaining gaps. Do not mistake automated scans for manual review.

2. **Close source-distribution rights and privacy findings.** Preserve the full
   Apache license, project NOTICE and upstream notices. The 28 installed direct
   dependency manifests and available packaged root notices now match the existing
   research; five missing packaged roots have verified saved upstream text evidence
   in `research/public-candidate-notice-reconciliation.json`. Do not repeat retrieval.
   Review only the actual source distribution now; a future binary/container release
   requires its own review. The original geometric favicon has recorded provenance.
   Do not republish the unverified historical icon or private reconstruction receipts.

3. **Finish and verify public collaboration documents.** Ship README, SETUP,
   CONTRIBUTING, ROADMAP, WORK_PACKAGES, architecture and third-party notices with
   working relative links. Include a private security-reporting route once configured.
   Document the maintainer's actual review process without inventing additional
   independent human maintainers or response-time promises.

4. **Complete exact-tree acceptance.** Retain the successful strict type checks,
   30 demo tests, two earlier built-demo tests, 49 standalone tests and owner-approved
   macOS browser trial. Rerun affected checks after changes. Independent review must
   identify the exact candidate and unresolved findings. Windows/Linux and live-agent
   acceptance remain contributor work, not prerequisites we falsely claim passed.

5. **Publish only the reviewed source snapshot.** Obtain approval identifying the
   final candidate and destination. Use an isolated checkout based on the public
   repository, with explicitly approved public author/committer name and email.
   Do not attach a public remote to the private checkout, mirror private branches,
   upload installed dependencies or force-push over public work. Verify remote files
   against the approved manifest after one coherent source upload.

6. **Open substantial contributor assignments.** Create ready issues for DEMO-UX
   and separate OS setup assignments from WORK_PACKAGES, with exact public base,
   allowed paths, prerequisites, checks and reviewing maintainer. Use ordinary
   confirmed assignments; do not revive the private automated jobber queue.
   Contributors can take another independent assignment while review is pending.

## Repository protection decision still pending

The earlier request to enable private vulnerability reporting, secret scanning and
push protection has not received a specific answer. The latest explicit approvals
covered identity content and website uploads, not these settings. Request that
decision separately; do not silently enable them or describe them as active.

For main-branch protection, propose blocking force pushes and deletion and requiring
PR review without checks that do not exist. Do not lock out the sole actual maintainer
by inventing a second human approver. Organization-wide 2FA changes can affect other
members and require separate scope. Keep Actions disabled, no privileged public-PR
runners, no scheduled polling and no paid-overage changes.

## After contributor launch

Return to the borrow-before-build assessment: choose maintained upstream components
against the remaining product gaps, verify licenses and integration tests, then update
the completion plan. Prioritize the usable project/task/agent/result/review path.
Announcing the repository is not completion of the Control Room product.
