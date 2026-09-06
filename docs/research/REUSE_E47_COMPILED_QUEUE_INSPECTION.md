# E47 — compiled queue inspection and VPS handoff

2026-09-06. Local build work; no physical database or deployment.

The E40 inspector was source-only. The VPS build now exports it as
`dist-vps/server/nativeQueueInspection.js`, preserving the external installed pg-boss
dependency boundary. No additional runtime logic or automatic invocation was added.
This lets an authorized preparation runner use the same compiled revision as the app,
rather than requiring a TypeScript source checkout for that particular operation.

The existing actual-package schema test now selects this compiled export in compiled
mode. Its assertions exercise an intact schema, six individually failed upstream probes,
pre/during-query abort, extra index and missing index even while the version stays 40.
There is no new mock inspector and no fallback if the artifact is missing.

`pnpm run test:queue-compiled` provides one shell-portable invocation for the schema
test plus the three full-host task journeys. It uses this repository's installed package,
sets compiled mode in the child environment and bounds the child to two minutes.
The only database is disposable PGlite. Source selection and compiled selection remain
distinct; neither proves physical PostgreSQL or another operating system.

[VPS compiled handoff](../VPS_COMPILED_HANDOFF.md) records the artifact/dependency boundary,
available verification and unresolved preparation, credentials, installation, service,
real-agent and operational prerequisites. It explicitly does not authorize Johnny5 to
provision anything, share Mac dependencies, broaden operational SQL roles or improvise
the secret/configuration setup. The inspector still needs a bounded approved SQL port;
abort checks alone are not an SQL cancellation implementation.

Verification: stage zero, build, TypeScript, targeted lint, script-inventory test,
all four compiled queue scenarios and all 35 compiled regressions pass. No downloads,
lockfile changes, live calls, credentials, listeners, GitHub or deployment effects.
CUA again reported the Mac locked; no unlock bypass was attempted. Browser interaction
remains dependent on owner unlock, not a reason to mark the broader program complete.
