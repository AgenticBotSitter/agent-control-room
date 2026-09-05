# CR14C private approval interface verification

Date: 2026-09-05. Accepted product: `b094a1e8083ae8b8af88b4fb3a8a12fde6246ef0`.
Tree: `18525f618ec0016ea6fb38953e391f112287ea2f`.
Base: `38592a4a1435d6d7927ec90eec8572317b771bce` (PR #312).

The private task panel and authenticated HTTP handler now mount bounded unsigned review, already-signed
file intake and historical receipt reconciliation through the verified two-pool bootstrap. The browser
does not receive native enrollment, credentials, public trust configuration or private signing material.
Application SQL roles are unchanged. Stored signatures never mean an agent started or remains authorized.

The panel explicitly describes the missing integrated owner signer. File import is an interim intake
capability, not the completed owner approval experience. There is no live dispatch or production setup.

Producer focused verification: `node --import tsx --test tests/web-task-approval.test.ts
tests/web-task-approval-browser.test.tsx` exited zero, 10 passed. Compiled private build and all 18 private
checks passed, including actual compiled approval prepare/store/read/logout and browser asset isolation.
The separate Sites build, four rendered route tests, TypeScript, full ESLint and disposable migrations
0001–0047 (133 tables) passed. The retained full lifecycle wrapper exited zero: CR14C412, preparation769,
main991 passed with two existing platform skips, and post-suite392. Whitespace passed. No product code
changed after independent review or during these checks; only the documentation handoff followed.

Independent review accepted this exact product with no blocking findings. The reviewer ran
`node --import tsx --test tests/web-task-approval.test.ts tests/web-task-approval-browser.test.tsx
tests/web-task-startup.test.ts tests/approval-lifecycle-reconciliation.test.ts`: 29 passed, exit zero.
`node --import tsx --test tests/vps-built-approval.test.mjs` passed two compiled checks, exit zero.
Its initial invocation without the tsx import failed module resolution before tests; the corrected command
passed without rebuilding. Component-level delayed file-selection/task-switch guards were reviewed in
code, not exercised by static markup tests. Transport uncertainty and historical read races are tested.

Negative evidence: an initial GET-origin test assumed an Origin header alone should be rejected;
the shared boundary correctly checks GET URL and cross-site metadata. The test now exercises POST
wrong origin and GET cross-site metadata. A browser expectation was corrected after immutable receipt
checks intentionally rejected contradictory digests. The role-revocation fixture initially tried an
administrative UPDATE after a restricted session, then unsuccessfully used RESET SESSION AUTHORIZATION.
PGlite retains its latest session identity on RESET; explicitly restoring the disposable postgres setup
role fixes only the fixture, with no application privilege change. Final focused checks cover all cases.

No browser-click test, physical listener, native/provider call, real credentials, host service, production
database, deployment or merge occurred. PR #312's exact base passed GitHub CI run33989108566 at
2026-09-05 20:26:21 UTC; that prerequisite pass is not acceptance of this new change.
