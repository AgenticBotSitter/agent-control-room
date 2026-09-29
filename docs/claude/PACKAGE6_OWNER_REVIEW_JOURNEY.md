# Package 6 owner-review journey

Branch base: `e833a934`. This package extends only the disposable three-agent rehearsal. It makes no live database, role, grant, or service change.

The journey now opens each pending result through the same authenticated HTTP API used by the website, checks the exact artifact and review target, records an owner decision, replays that identical decision, and reads the saved result again. Hermes receives one `changes_requested` decision; Claude and Codex each receive one `accepted` decision. Each target still has one result and exactly one saved review after replay. The owner cannot submit another decision on that target.

An accepted review is **not** the same as a ready/completed target in this profile: the separate structural verification scenario has not run. The two accepted targets therefore remain `pending`; the correction target becomes `changes_requested`. The test asserts these actual states rather than misreporting acceptance as completion.

Verification on a new disposable PostgreSQL 17 cluster, local port 15541: the full three-agent journey passed and stopped its rehearsal services; TypeScript check, production build, and all 14 existing Mac-local browser-journey tests passed. The first browser-test attempt was sandbox-blocked before execution because PostgreSQL shared memory was denied; the permitted rerun passed. `pnpm lint` is not defined in this checkout.
