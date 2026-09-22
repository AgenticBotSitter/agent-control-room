# macOS service custody decision

**Decision:** the first installable macOS release will use descriptor-safe
service-definition publication, fixed `launchctl` operations, and fresh
authenticated application health. A later signed-app distribution may replace
the registration backend without changing Control Room's installation journal,
database, scheduler, worker lifecycle, or agent adapters.

## Honest guarantee

Within an operating-system trust boundary that includes root and the
installation owner's account, Control Room publishes the reviewed service
definition through a held, verified directory handle without following
symbolic links or replacing an existing definition. It invokes the fixed
system service manager for the captured owner domain and service label,
rechecks the published definition, and accepts completion only after a fresh
authenticated response from the running service binds the expected
installation, release, configuration, service instance, database,
protected-data, supervisor, and readiness evidence.

These checks establish controlled publication, a service-manager request, and
authenticated application health. They do **not** prove that launchd consumed
the same filesystem inode, protect against a malicious process already running
with the owner's authority, or independently attest every byte launchd
executed. Ambiguity after an effect may have begun is uncertainty and cannot
trigger automatic retry.

## First-release packages

The native publication and service-manager port must:

- inspect every path component without following links and reject unauthorized
  ownership, mode, ACL, hard-link, pre-existing-target, or substitution state;
- publish only complete reviewed bytes through the held parent and retain a
  publication-and-recheck token;
- invoke only fixed `/bin/launchctl` arguments for the captured `gui/<uid>`
  domain and fixed Control Room label, with no shell, ambient environment, or
  caller-selected command;
- bound output, deadlines, cancellation and child cleanup, and treat a lost or
  malformed reply after entry as uncertainty;
- require the separate authenticated health-evidence contract before durable
  success. A successful service-manager return alone is insufficient and
  never grants agent readiness.

Configuration and release custody must also bind the Node runtime, launcher,
dependencies, service definition, executable paths and their ancestors. A
Homebrew or version-manager path is not trusted merely because it exists.

## Later signed-app path

macOS 13 and later provide `SMAppService` for a code-signed containing app with
an embedded `Contents/Library/LaunchAgents` definition and bundle-relative
program. That is the preferred later distribution path because it removes our
external definition publication and direct bootstrap glue. It adds signed-app
packaging, signing custody, owner consent, upgrade and unregister work; it does
not remove authenticated health, journal settlement, configuration custody,
or agent-readiness gates, and it is not an exact-inode attestation.

A migration must stop admission, drain and stop the old service, verify its
absence, register the signed app service, obtain fresh health evidence, and
settle the existing journal. Both backends must never run concurrently under
the same label.

## Owner-only boundary

Source development and disposable tests can proceed without owner action.
Attached-owner confirmation is still required for real filesystem publication,
service registration or start, credential provisioning, signing access,
background-item consent, and final real-host qualification.
