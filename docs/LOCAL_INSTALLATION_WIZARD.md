# Local installation wizard

**Status:** source-only first-run presentation on the protected Settings page.
It does not install, enable, or operate Control Room.

## Purpose

`private-app/app/local-installation-wizard.tsx` turns the supported installation
contract into a plain-language, read-only first-run journey. It is designed for
the release installer described in `SUPPORTED_INSTALLATION_EXPERIENCE.md`, where
a user downloads one versioned release and opens a launcher instead of cloning
the repository and entering a sequence of developer commands.

The component consumes the existing redacted `InstallationSetupViewV1`. It does
not accept executable paths, commands, credentials, signing material, database
passwords, worker identities, or private storage paths.

## What it shows

- the release download and launcher-verification stage;
- **This computer** and **Several computers** as placement choices for the same
  product and authority model;
- the authority, protected-data, recovery, background-service, worker, and
  final-review stages;
- recorded, missing, failed, or unavailable proof without translating source
  preparation into a live status; and
- remaining categories visible in the saved protected setup projection,
  including each local connector's remaining category. Database,
  protected-data, owner-access, release-authenticity, and final-activation
  proof are not projected there yet, so the page never treats this list as
  complete installation readiness.

## Effect boundary

This component contains no buttons, forms, mutation requests, process launch,
database access, filesystem access, or credential handling. Real changes occur
only through separately reviewed installation-owned actions after the owner is
shown the proposed effect and confirms it. Closing and reopening the eventual
wizard must reload canonical saved evidence rather than repeat an effect.

## Integration still required

The protected Settings page now places this component above the existing
detailed installation evidence. It reads only the same redacted setup
projection. A future release launcher may link directly to Settings after the
private website is available. Later action controls must remain separate from
this status component and must preserve the existing authority, idempotency,
evidence-redaction, and owner-confirmation rules.

The installed-product acceptance journey remains the authority. A rendered
component test is not evidence that a database, backup, service, worker, or
release installation works.
