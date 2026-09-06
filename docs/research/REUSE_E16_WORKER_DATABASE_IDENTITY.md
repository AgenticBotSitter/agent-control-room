# E16 — dedicated queue worker database identity

2026-09-06. Local implementation; no native database or credentials.

`verifyNativeQueueWorkerDatabase` reuses the existing application session gate:
configured login must equal both current_user and session_user, database must match,
PostgreSQL major/settings must match, and only the LOGIN plus the fixed NOLOGIN worker
role may be inherited. SQL timeouts, search path, replication mode, recovery/read-only
state and database CREATE/TEMP restrictions remain the same as application roles.

The common session check was extracted without weakening the existing five profiles.
Worker verification then applies E11 effective queue-only permissions, rejects unrelated
schemas, ALTER SYSTEM grants and applicable default ACLs. Unlike an application writer,
the worker does not need to read canonical owner/project tables. Current task authority
must still be resolved by a separately authorized coordinator before dispatch.

## Evidence and limits

42 combined package tests and 78 existing database/startup regression checks pass.
Typecheck, targeted ESLint and whitespace validation pass.

The actual-package test creates a synthetic worker LOGIN, exercises the shared session
gate and then processes one synthetic job through the existing owned runtime. It rejects
wrong login/database, disabled statement timeout, changed search path, SET ROLE in place
of the intended session identity, a LOGIN-enabled base role, extra schema and default
table grants. Restoring configuration restores acceptance.

As with existing application tests, only unsupported PGlite TEMP metadata is substituted;
the unmodified check rejects that real metadata. An initial fixture run failed to ALTER
the role after its rejected SET ROLE scenario. The test now explicitly restores its
administrator before setup mutations. This is single-engine PGlite evidence, not proof
of real PostgreSQL session reset, pool isolation, sockets or concurrency.

The verifier is read-only and not mounted in production startup yet. Connection topology
validation, pool ownership and worker lifecycle composition remain bootstrap work.
Full schema acceptance and real PostgreSQL qualification remain required. No new
package, download, native service, provider call or production DB configuration.
