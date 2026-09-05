# CR14C native current-policy evidence

Date: 2026-09-05. Status: independently accepted unwired component; local verification passed.

Initial head `21b0a19cbc8e17f703bd483eb3a5de98b6bd0053` was **not accepted**. Independent review
found a P1 stale-permission window across key/profile awaits despite 49 passing focused tests.
The initial broad run also passed (CR14C 327, preparation 769, main 906 with two existing platform
skips, post-suite 392); passing tests did not override the security finding.

Remediation head `70a3fef23baf1ef680646f03ea52e47c148f81f1` adds synchronous verified-state
fencing throughout the controller boundary. Regressions mutate actual disposable journal/trust stores
during awaited work: cancellation, owner-signed server revocation, narrowed owner ceiling, and owner
pin-store closure all deny before admission or fake transport. The new test file passes 17 tests.
Independent re-review accepted this exact head with 56 passed, zero failed/skipped and no remaining
blocking findings. Accepted tree: `087be3d5fdf1e2938c30a63a1874213ba97eb263`.
Final CR14C suite: 334 passed; preparation suite: 769 passed. Private application build and its 16
compiled tests passed; Sites build and four rendered tests passed. Migrations 0001–0046 verified
132 PostgreSQL tables using the disposable local test engine. Final main suite: 913 passed, two existing
platform skips; post-suite: 392 passed. TypeScript, full ESLint and whitespace checks passed.

Earlier test-authoring run: 16 passed, five reported failures (including the parent subtest). The tests
incorrectly expected adapter rejection instead of its established failed result and omitted the required
quarantine reason. These fixture/assertion errors were corrected without loosening product checks; the
next focused run passed 21. This record preserves both negative evidence and the later security finding.

No native credentials/provider calls, listeners, production database, deployment or merge were used.
See `CR14C_NATIVE_CURRENT_POLICY_CONTRACT.md` for the exact remaining integration boundary.
