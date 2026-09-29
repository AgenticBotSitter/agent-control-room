# PR 407 fix report

## Outcome

The requested guard proof is complete. The production guards were already correct; the Mac-local process test now proves the refusal behavior for a signed-in foreign-tenant project, missing and foreign Agents/Settings pages, and every common non-GET method on the Inbox and Agents APIs. Each requested guard mutation was applied independently, made the new test fail for the expected reason, and was reverted.

The local Agents UI now distinguishes an absent installation source from an expired session or failed read. An expired session offers the local sign-in route, failed reads show an explicit error and retry, and the “not available on this computer yet” note appears only for explicit missing-source codes.

## Findings fixed

- fixed `tests/mac-local-web-process.test.ts:67`: seeds a disposable foreign tenant, workspace, adapter, and project in the existing PGlite fixture.
- fixed `tests/mac-local-web-process.test.ts:148`: a signed-in request to the foreign project's Agents fallback must return 404.
- fixed `tests/mac-local-web-process.test.ts:152`: missing and foreign Agents/Settings pages must return 404 without rendering.
- fixed `tests/mac-local-web-process.test.ts:159`: POST, PUT, and DELETE on both Inbox and Agents APIs must return 400.
- fixed `src/web/v1/connection-browser-client.ts:5`: preserves connection HTTP 404 as `not_found`, distinct from a failed request.
- fixed `private-app/app/project-agent-workspace.tsx:129`: provides sign-in recovery for expired sessions, an error with retry for failed requests, and missing-source-only local availability copy.
- fixed `tests/project-agent-visibility.test.tsx:92`: proves missing-source and failed-request classification.
- fixed `tests/project-agent-visibility.test.tsx:190`: proves the three UI recovery states do not get conflated.

## Mutation proof

Each mutation used the same focused command:

```sh
node --import tsx --test --test-concurrency=1 tests/mac-local-web-process.test.ts
```

1. Deleted `await tasks.authorize(identity, projectId);` from the Agents fallback, ran the command, and restored the line.
   - Exit 1: `the agents fallback must authorize the project before synthesizing a response`; actual 200, expected 404.
2. Deleted `else await projects.getView(identity, projectId);` from the Agents/Settings page gate, ran the command, and restored the line.
   - Exit 1: `agents must refuse project:missing`; actual 503 after reaching the forbidden render callback, expected 404.
3. Deleted `request.method !== "GET" ||` from both the Inbox and Agents API guards, ran the command, and restored both expressions.
   - Exit 1: `POST inbox must be refused`; actual 200, expected 400.

After restoration, this command passed 5/5 Mac-local process tests. The combined focused command for the process and UI passed 17/17.

## Verification

- `pnpm install --frozen-lockfile`: pass.
- `node --import tsx --test --test-concurrency=1 tests/mac-local-web-process.test.ts tests/project-agent-visibility.test.tsx tests/project-route-isolation.test.mjs tests/product-configuration-shell.test.mjs tests/private-shell-navigation.test.tsx`: pass, 65/65.
- `pnpm run test:project-agent-visibility`: pass, 12/12.
- `pnpm run test:product-shell`: pass, 104/104.
- `pnpm check`: pass.
- `pnpm run check:demo`: pass.
- `node scripts/check-test-lane-coverage.mjs`: pass; all 506 test files are reachable from GitHub Actions.
- `git diff --check`: pass.

DB-VERIFIED: no (no port block)

## Branch and base

- PR: https://github.com/AgenticBotSitter/agent-control-room/pull/407
- Branch: `codex/mac-project-sections`
- Verified implementation commit: `96e4bce78c35999cec8167953e43f1b546da8e07`
- Up to date with `origin/main` at `fcae83680dd2ba2f532d10f962d04c52740801ea`; the required merge reported `Already up to date`.
- The final pushed head is the report commit containing this file and is recorded by the PR and final handoff.

## Environment note

The requested linked worktree could not write its external Git metadata and already contained unrelated changes. Per the shared rules, work was completed in a clean nested clone under the writable workspace with the required generic commit author configured before the first commit. The original dirty checkout was not modified.

No network PostgreSQL cluster or listener was started. The cross-tenant tests use the repository's disposable PGlite fixture and are reported only as test evidence, not real-PostgreSQL verification.
