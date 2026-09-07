# Ready-work template

Unpublished maintainer template. Do not mark an item ready with missing prerequisites.
Suggested title: `[Any OS][UI] Show archived projects separately`.
Use the actual required platform: Any OS, macOS, Windows or Linux. Add a runtime/version
requirement to the title when it determines whether a contributor can finish the work.

## Outcome

What should the user be able to do?
What observable behavior proves this is complete?

## Can you take this work?

- Required OS, architecture, runtime and tool versions:
- Exact public base commit:
- Required prior issues/PRs:
- Required resources or downloads and their approved setup instructions:
- What can be tested using disposable data alone:
- Named reviewing maintainer:

If a requirement is unavailable, ask before starting. Platform eligibility does not
authorize credentials, provider calls, deployment or access to another person's machine.

## Scope and reuse

- Existing components to use:
- Files/components allowed to change:
- Out of scope:
- Upstream candidate/version/license if adapting code:
- Specific reason for custom infrastructure, if proposed:

## Acceptance checks

List reproducible commands and expected behavior, including a relevant failure case.
Identify which checks are automated, which need human interaction and which require
separate live-operation authorization. Do not count a simulated call as a live test.

## Claim, submit and continue

Ask for assignment. Wait for the maintainer to confirm one responsible contributor;
a comment alone is not a reservation. Work in your own branch/checkout and submit a PR
with exact revisions, evidence, attribution and known limitations. You may continue
another assigned independent item while the PR is reviewed.

Fix ordinary in-scope mistakes and rerun relevant tests. If blocked, preserve the current
revision in a draft PR, post a sanitized reproduction and the missing decision, and ask
to release the assignment when unable to continue. Never retry an uncertain external
action outside its approved limits. Maintainers review and integrate the result.
