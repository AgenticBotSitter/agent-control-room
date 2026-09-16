# GitHub App worker broker

## Outcome

The organization-owned **Agent Control Room Workers** GitHub App is the future coordination
identity for this one public repository. It replaces repeated worker polling and shared
long-lived user credentials for queue operations with one protected VPS service that mints
short-lived installation tokens. Worker computers receive neither the app private key nor an
installation token. Existing contributor identities remain responsible for Git pushes until a
separately reviewed push path exists.

This repository contains the effect-free authentication and webhook admission core, a
PostgreSQL replay-store adapter and least-privilege database role, and the private broker
composition that converts verified events into content-free wake-up hints, a durable PostgreSQL
wake store, and an inert loopback-only listener. It is not live. No key has been generated, no
webhook has been enabled, no database migration has been applied, and no listener has been opened.

## Recorded public identifiers

- App ID: `4960037`
- Installation ID: `162066346`
- Repository: `AgenticBotSitter/agent-control-room`

These identifiers are not secrets. The private key and webhook secret are secrets and must not
appear in GitHub, R2, logs, issue comments, worker files, or chat.

## Security boundary

1. Generate the private key only after the reviewed VPS broker and secret paths are ready.
2. Transfer the key directly to owner-only protected VPS storage. Do not download or copy it to
   worker machines.
3. The broker may mint one-hour installation tokens, cache them only in memory, and redact them
   from every error and audit record. Tokens are used inside the broker and are not returned to
   workers.
4. The broker exposes named operations, not an arbitrary GitHub proxy. Worker-facing operations
   must not include merge, workflow editing, repository administration, secrets, deployments,
   environments, member management, or app-permission changes.
5. The app's Pull requests write permission is needed for worker PRs but also permits merges at
   GitHub's permission layer. The broker must therefore never implement a merge operation.
   Final merge remains a separate maintainer action.
6. Every webhook must pass body-size, HMAC signature, repository, installation, event, and action
   checks before it can create a wake-up hint. Production then commits both replay keys and the
   content-free wake-up hint in one PostgreSQL transaction: either all three records become
   durable or none do. A wake-up hint is
   not work authority; workers still follow the repository claim and review controller.
7. Wake-up hints contain only event type, action, repository, issue or pull-request number,
   delivery sequence, and observation time. Issue titles, comments, PR bodies, and other
   repository-controlled text never enter the notification channel. A sink failure falls back
   to the staggered read-only watcher; it never causes unverified work to run.
8. The included in-memory replay adapter and separate replay-store/wake-sink route are
   disposable-test compatibility only. The packaged production composition permits only the
   combined PostgreSQL admission store and survives process restarts. A live listener remains
   blocked until the migrations and narrow database role are rehearsed on real PostgreSQL and an
   operator-owned secret/supervisor package is reviewed.
9. The worker-hint read route requires an injected private authorizer. The public package does not
   invent or embed shared credentials. Failed authorization reveals no hint metadata. A physical
   listener binds only to loopback, starts only through an explicit effectful call, and has the
   same bounded shutdown behavior as the existing private Control Room listener.

## Activation order

1. Review and merge the effect-free authentication and webhook admission core. **Complete.**
2. Build the private VPS broker around narrow, allowlisted worker operations and bounded audits.
   **Complete in source; not activated.**
3. Add a private durable notification sink and package the inert loopback service in the VPS build.
   Retain staggered polling as a quiet fallback. **Complete in source; not migrated or started.**
4. Rehearse with fake credentials and injected GitHub responses.
5. Prepare a persistent supervisor, owner-only secret files, rollback, and health checks.
   **Complete in source; not installed or activated.**
6. With fresh owner approval, generate one private key and place it directly on the VPS.
7. With fresh owner approval, configure a webhook URL and secret, then verify delivery signatures.
8. Pilot one worker. Confirm token expiry, restart, disconnect, duplicate delivery, 403/429
   backoff, audit redaction, and rollback to the existing read-only watcher.
9. Roll out to other workers only after pilot acceptance.

The production wrapper should use owner-only secret-file paths such as
`ACR_GITHUB_APP_PRIVATE_KEY_FILE` and `ACR_GITHUB_WEBHOOK_SECRET_FILE`; secret values must not be
placed directly in service definitions or command lines. Exact paths and service ownership are
private operator configuration, not public repository data.

## Reviewed operator package

The repository now includes an inert production package under `deploy/github-app/` and the
launcher `scripts/run-github-worker-broker.mjs`. It does not install or start itself.

- `operator-config.mjs` reads one non-secret settings file and four secret files through one
  opened file descriptor, so the object checked is the object read. Production files are owned
  by root, never by the unprivileged service identity. Secrets may be group-readable by the
  dedicated service group but cannot be group-writable or accessed by other users. Final-path
  symlinks, changing files, missing files, unexpected settings, embedded secret values, and
  oversized files fail closed.
- The GitHub App key is parsed by performing one offline signature. This sends nothing to
  GitHub and the generated proof is discarded. The service does not exchange an installation
  token during preparation.
- The worker read route uses a separate, fixed-length bearer secret and constant-time
  comparison. The webhook secret, worker secret, database password, and app key are never
  accepted on the command line or stored in the service unit.
- `agent-control-room-github-worker-broker.service` runs as the dedicated `control-room` user,
  applies systemd hardening, restarts only after failure with a bounded rate, and gives shutdown
  40 seconds to complete. It references only paths, never secret values.
- Readiness is the existing `/healthz` database probe. The application prints its ready message
  only after the loopback listener binds; the `Type=simple` systemd unit itself does not claim a
  readiness-notification protocol. Failed setup closes acquired database/listener resources and
  returns a nonzero status with a sanitized message.

### Operator-owned files

The examples define shapes only. A VPS operator must create the operator module as root-owned and
not group- or world-writable. The settings and four secret files are `root:control-room` mode
`0640`, making them readable but not writable by the dedicated service identity and inaccessible
to other users. Private values never enter GitHub, chat, R2, shell history, or logs:

1. `/etc/control-room/github-worker-broker.operator.mjs`, copied byte-for-byte from the pinned
   release's reviewed `deploy/github-app/operator-config.mjs`, root-owned and immutable to the
   service identity.
2. `/etc/control-room/github-worker-broker.env`, copied from the example and containing paths
   only.
3. `/etc/control-room/github-worker-broker.settings.json`, based on the example, with the
   deployment-selected loopback ports and dedicated database name.
4. The four files named by the environment file: app private key, webhook secret, worker-read
   secret, and dedicated broker database password.

The database role and migration must be applied and verified before the unit is enabled. The
exact production sequence is: make a verified backup; apply the reviewed migration with the
restricted migrator; verify the ledger and broker grants; install the unit but leave it disabled;
run a foreground health/restart rehearsal; then request fresh activation authority.

Before any listener attempt, the operator can run the launcher with `--check --configuration`
and the protected operator-module path. Check-only mode reads and validates the protected files,
performs the offline key signature, constructs and closes the lazy database pool, and exits. It
does not connect to PostgreSQL, contact GitHub, or open a listener. Passing this check is not live
database, tunnel, webhook, restart, or rollback evidence.

The public tunnel route must forward **only** `POST /webhooks/github` to this listener. It must
not publish the health or worker-hint paths. Worker hint reads stay on the approved private
machine path (for example, SSH forwarding or the owner's private network) and still require the
separate worker-read secret. The webhook path relies on GitHub's verified signature rather than
the owner's human Access login; no other path receives that exception.

### Rollback

Stop and disable only this broker unit, remove the webhook route from the private tunnel, revoke
the App private key in GitHub, and return workers to their existing read-only watchers. Do not
delete wake or replay rows during incident response. If a migration rollback is required, restore
the verified pre-change database backup into the approved recovery target; do not hand-edit the
production schema.

## Rate limits and Actions

The GitHub App gives automation a separate installation rate bucket, but it does not make wasteful
requests free. Webhooks should trigger prompt reads; fallback watchers should be staggered, cache
unchanged results, obey `Retry-After`, and use exponential backoff with jitter after 403 or 429.
A transient rate-limit tick must not wake an AI worker.

The app does not reduce GitHub Actions usage by itself. Keep Actions efficient with larger work
packages, path-focused checks during development, cancellation of superseded runs, and one full
gate at the final submitted head.

## Rollback

Disable the private broker and webhook route, revoke the generated private key in the GitHub App
settings, and return workers to the existing read-only inbox watcher. Revocation is preferred to
copying or rotating a potentially exposed key among worker machines.
