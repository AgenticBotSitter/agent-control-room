# CR14C canonical approval storage — accepted repository evidence

Date: 2026-09-05. Base: `73ca952922bad349cab5d066d26bb9dbcef18697` (PR #310).
Initial product: `5fe456b88df60f71401a6043db35eca922518045`.
Inventory follow-up: `5fac6177782b5e0743d2a921219fbd29e1879355`, tree
`44889457c38fbd0c6a656454583876a6f2d8a83d`.

Ten new disposable tests passed: exact save/replay, forged/wrong-task/replacement packets, owner/expiry
requirements, cancellation/trust revocation/expiry before commit, append-only constraints, tampered readback,
actual restricted coordinator versus private-web roles and input snapshotting across asynchronous reads.
The existing paired intake/preparation/isolation checks also passed. No native/provider attempt was made.

Two initial TypeScript invocations found the same optional trust narrowing error before tests ran. The
explicit fail-return correction passed TypeScript and focused ESLint; no verification or authority rule
was weakened. The final inventory follow-up changes the fixed table count from 132 to 133 for migration0047.

Independent review of the initial product passed 48 tests with no actionable findings. It checked canonical
locks/owner permission, immutable HMAC evidence, replay/conflict behavior, shared signature verification,
before-commit fences, privilege matrix and application/native isolation. Final independent re-review
accepted `5fac6177782b5e0743d2a921219fbd29e1879355` with no actionable findings, verifying the sole
inventory correction and passing all 19 fixture-preparation tests at that head.

Review commands (both exit zero):

```sh
node --import tsx --test tests/canonical-approval-storage.test.ts tests/canonical-approval-preparation.test.ts tests/native-approval-intake.test.ts tests/hermes-native-isolation.test.ts tests/web-coordinator-database.test.ts
node --import tsx --test tests/web-fixture-preparation.test.ts
```

Both application builds passed with 16 private compiled checks and four rendered-route checks. Disposable
migrations 0001–0047 verified 133 tables. Full TypeScript/ESLint and initial CR14C395/preparation769 passed;
The running lifecycle completed main 974 passed/two existing platform skips and post-suite392 passed,
with no failures. The one-line inventory correction was committed during that wrapper; the independent
19-test final-head fixture run directly validates its affected path. Final-head TypeScript, focused
inventory ESLint and whitespace were also rerun. Builds and full ESLint preceded only that count correction;
no other product code changed after the initial review.

No production database, credentials, owner signing, listener, deployment or merge was used. Trusted method
and SQL evidence storage are implemented; lifecycle/HTTP mounting, dispatch and live usage remain incomplete.
