# Supported installation experience

**Status:** product contract and build acceptance plan. The release installer
described here is not complete yet. Current source checks and disposable demos
must not be presented as an installed Control Room.

## What a user should experience

People installing Agent Control Room should not clone the repository, install
developer dependencies, or copy a sequence of commands from chat. GitHub is
the source and release channel; the supported product path is:

1. Download one versioned release for the computer from the GitHub Releases
   page and verify its published checksum.
2. Open the platform launcher. The launcher performs a read-only compatibility
   check, then opens the local setup page. It does not start agents.
3. Choose **This computer** or **Several computers**. Both choices configure
   the same controller, database, scheduler, task, result, review and
   correction system.
4. Complete the guided owner, database, protected-data, recovery and agent
   connection checks. Each check says what it will change before it runs and
   records only sanitized proof.
5. Review the final summary and separately choose to enable the installation.
6. Reopen Control Room from the installed launcher or a saved private web
   address. Upgrades use the same setup page and preserve the one authority
   database and protected data.

The source checkout remains the contributor path. It is not the normal user
installation path.

## One product, two placements

The installation records three independent choices:

- where the controller and website run;
- where the one PostgreSQL authority and protected results live; and
- where enrolled workers run.

**This computer** initially places the controller and workers together. A user
may later add a remote worker without reinstalling or migrating task history.
Moving the controller or database is a separate, guarded transition. Control
Room never keeps a local and remote database synchronized and never allows two
active controllers to write during a move.

## Release contents

Every supported release must contain one immutable application build and:

- a platform launcher and read-only preflight;
- a local setup website using the existing protected setup projections;
- database migration ledger and restricted-role verifier;
- private configuration and protected-data schemas, with no sample secret;
- background-service definitions that are generated but not installed before
  owner confirmation;
- backup, restore, upgrade and rollback procedures;
- required third-party licenses and attributions;
- a release manifest with version, platform, file digests and compatibility
  range; and
- uninstall instructions that leave authority data and backups intact unless
  the owner separately requests their removal.

The release must not contain a second scheduler, embedded development
database, shared agent credentials, private machine paths, or example data
that looks live.

## Guided setup stages

The local setup page is the durable checklist. Closing and reopening it must
resume from saved installation evidence, not silently repeat an effect.

| Stage | What the user sees | What may change only after confirmation |
| --- | --- | --- |
| Compatibility | Platform, release and available-space result | Nothing |
| Placement | This computer or Several computers, plus plain-English consequences | A reviewed placement plan only |
| Authority | PostgreSQL reachability, empty/new installation status and restricted-role readiness | Database creation, roles and migrations through a separate installation action |
| Protected data | Chosen private data location and available capacity | Owner-only directories and configuration |
| Owner access | Selected private login boundary and recovery explanation | The one guarded first-owner ceremony |
| Recovery | Backup destination and disposable restore status | Backup configuration and the first verified backup |
| Background service | Exact service, restart and rollback summary | Installation of the reviewed platform service definition |
| Local agents | Hermes, Codex and Claude shown separately as unavailable, qualified or ready for enablement | One installation-owned private binding per agent |
| Final review | Every passed, missing and failed proof; no secret values | Explicit enablement of the controller and selected workers |

No browser field directly supplies an executable path, credential, model,
provider, database password, signing key or command. Those values remain in a
private installation action with a redacted result returned to the page.

## First supported single-computer release

The first release candidate is intentionally narrower than the eventual
cross-platform product:

- macOS on the currently qualified architecture;
- one controller and website on that Mac;
- one PostgreSQL authority selected during setup;
- one protected local result directory;
- the existing scheduler;
- Hermes Agent enabled first for a bounded text-review task;
- Codex and Claude visible but unavailable until their distinct installed
  process checks pass; and
- project, task, result, review, correction, attention and installation pages.

The release candidate is not accepted because a build or disposable demo
passes. It must be installed from the produced release asset into an empty,
disposable user location using only the supported launcher and setup page.

## Acceptance journey

A release candidate passes only when an owner can complete this journey
without repository knowledge or chat-provided commands:

1. Download and open the release.
2. Run the compatibility check and start the setup page from the launcher.
3. Prepare a new **This computer** installation.
4. Record the one owner, one authority database, protected data and recovery
   evidence.
5. Install, start, stop and restart the reviewed background service.
6. Create a project and one bounded task in the website.
7. Deliver that task to the qualified Hermes adapter exactly once.
8. Review the saved result, request one correction and review the corrected
   result.
9. Restart the computer or service and prove that the task is not launched a
   second time and the saved result remains available.
10. Upgrade to a second test build and roll back before any new write, proving
    the existing database and protected result remain intact.
11. Uninstall the application while retaining data, then explicitly verify
    the retained-data recovery path.

All real database, service, login, agent and filesystem effects in this journey
remain owner-authorized. Automated tests may use disposable doubles but cannot
replace the clean-install acceptance run.

## How this grows into Several computers

The same release and setup page later add a remote-worker placement action.
That action enrolls a compatible worker route, sends the same signed delivery
packet, and uses the same result and review path. It does not export project
history to a worker or install another controller. Disconnect, reconnect,
revocation and uncertain delivery are handled through the existing durable
receipt and recovery records.

Moving the controller or authority uses the saved installation-transition
journal: pause new work, drain or mark uncertainty, verify backup and target,
fence the old writer, activate one new writer, and retain rollback evidence.

## Build order from here

1. Produce and validate a source-only release manifest and platform package.
2. Finish the local setup page as the single guided entry point.
3. Compose private configuration, PostgreSQL, protected storage, recovery and
   the macOS background service behind that page.
4. Run the clean-install journey with Hermes only.
5. Add the qualified Codex and Claude private host bindings to the same
   installation.
6. Publish a release candidate and repeat the journey from the GitHub asset.
7. Add remote enrollment and the controlled two-computer journey without
   changing the authority or task lifecycle.

Every substantial new component must first pass
[REUSE_DECISION_GATE.md](REUSE_DECISION_GATE.md). The implementation should
prefer the repository's existing PostgreSQL, pg-boss, React, service-package,
backup and adapter components; external code is adopted only when a pinned,
license-reviewed source inspection shows that it removes real implementation
work without adding another authority path.
