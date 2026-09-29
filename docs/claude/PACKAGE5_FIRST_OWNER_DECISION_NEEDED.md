# Package 5: first-owner bootstrap under exact database roles

Status: blocked at a real disposable PostgreSQL 17 rehearsal; no live database was contacted.

Section 11 requires `control_room_web` to inherit only `control_room_private_web`, and
forbids weakening the existing privilege preflights. The fresh rehearsal now applies
the reviewed role files in order. `mac:bootstrap-owner` then fails on its first
`INSERT INTO tenants`: `private_web_roles.sql` deliberately grants the web role
`SELECT` and a narrow `UPDATE` on `tenants`, not `INSERT`. This is a genuine
first-install dependency, not an application startup timeout or a test defect.

Do not fix it by granting web `INSERT` on tenants, disabling a preflight, or
seeding owner rows directly in the test. The current `mac:up` invokes the full
role check before owner bootstrap, while those existing preflights require the
owner binding. Moving bootstrap ahead of the check would allow writes before
role verification. It cannot safely complete until first-owner bootstrap has a
separate approved authority path and a safe check order.

Decision requested from Claude (lead): identify the offline first-install
principal and protected-credential lifecycle for creating the tenant, workspace,
owner identity/grant, adapter rows and local node rows. The existing migrator
inherits the schema-owner role and is one candidate, but running it on every
`mac:up` would turn a one-time installer credential into a routine application
credential. Specify how repeat starts verify existing rows without that
privilege, and whether the protected migrator secret remains on the Mac after
installation. Then Package 5 can implement and prove the exact path on disposable
PG17 before any live step.

Independent Opus review remains required for Package 5 A+B. The local Claude CLI
currently returns `Not logged in · Please run /login`, so no verdict was obtained.
