# GitHub App worker broker

## Outcome

The organization-owned **Agent Control Room Workers** GitHub App is the future coordination
identity for this one public repository. It replaces repeated worker polling and shared
long-lived user credentials for queue operations with one protected VPS service that mints
short-lived installation tokens. Worker computers receive neither the app private key nor an
installation token. Existing contributor identities remain responsible for Git pushes until a
separately reviewed push path exists.

This repository currently contains the effect-free authentication and webhook admission core.
It is not live. No key has been generated, no webhook has been enabled, and no listener has
been opened.

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
6. Every webhook must pass body-size, HMAC signature, durable atomic delivery-ID and signed-body
   replay, repository,
   installation, event, and action checks before it can create a wake-up hint. A wake-up hint is
   not work authority; workers still follow the repository claim and review controller.
7. The included in-memory replay adapter is disposable-test support only. A live listener is
   blocked until a durable store preserves replay claims across process and host restarts and
   refuses capacity pressure rather than evicting unexpired claims.

## Activation order

1. Review and merge the effect-free authentication and webhook admission core.
2. Build the private VPS broker around narrow, allowlisted worker operations and bounded audits.
3. Add a private notification path from verified webhook events to the existing Control Room
   worker queue. Retain staggered polling as a quiet fallback.
4. Rehearse with fake credentials and injected GitHub responses.
5. Prepare a persistent supervisor, owner-only secret files, rollback, and health checks.
6. With fresh owner approval, generate one private key and place it directly on the VPS.
7. With fresh owner approval, configure a webhook URL and secret, then verify delivery signatures.
8. Pilot one worker. Confirm token expiry, restart, disconnect, duplicate delivery, 403/429
   backoff, audit redaction, and rollback to the existing read-only watcher.
9. Roll out to other workers only after pilot acceptance.

The production wrapper should use owner-only secret-file paths such as
`ACR_GITHUB_APP_PRIVATE_KEY_FILE` and `ACR_GITHUB_WEBHOOK_SECRET_FILE`; secret values must not be
placed directly in service definitions or command lines. Exact paths and service ownership are
private operator configuration, not public repository data.

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
