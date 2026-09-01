# CR12B-IDEA-060 local repository-fake pilot acceptance

**Status:** Repository implementation and automated restart rehearsal pass; the real owner-attended browser run is pending.

**Date:** 2026-08-31

## Implemented boundary

- One exact development-only switch selects the pilot. Production mode and all unconfigured runs remain disabled.
- The exact switch selects Vinext's Node development runtime so PGlite remains local and executable. Ordinary previews
  and every production build retain the Cloudflare plugin; the pilot switch is ignored outside development mode.
- The foreground launcher binds Vinext to `127.0.0.1:3000`; forwarded and non-loopback requests fail closed.
- A random master key is retrieved from the owner's macOS Keychain by the owner-attended launcher. Domain-separated keys
  protect owner sessions, Idea Lab records, the project catalog, and its independent high-water chain.
- A separate one-time owner code establishes one HMAC-authenticated, append-only, maximum-15-minute browser session.
  The code is never stored in raw form, and exact reuse is rejected across restart.
- PGlite is restricted to this non-production pilot, stored outside the repository with owner-only directory mode, and
  applies digest-pinned migrations through a local migration ledger.
- The protected runtime uses only `DeterministicIdeaLabFakeDriverV1`. It exposes no live evidence verifier and cannot
  select Hermes, Codex, a local model, the VPS PostgreSQL target, or any public destination.
- Owner-created projects are added to an HMAC catalog and a separately keyed append-only high-water revision before the
  protected project read can resolve them.
- The Idea Lab page enables the protected controls only under the exact pilot composition. New owner-promoted projects
  receive dynamic overview, Settings, Idea origin, and shared monitoring tabs without substituting fixture truth.
- Control-C stops the foreground server. No daemon, login item, deployment, or production service is installed.

## Automated evidence

The automated rehearsal creates the owner session, runs a complete repository-fake panel, synthesizes it, promotes a
project, resolves its protected catalog scope, pauses and resumes it, closes the PGlite process, reopens the same data,
and verifies the same browser session, Idea Lab session, project version, catalog high-water, and protected project read.
It also rejects a wrong code, code replay, forwarded requests, and any pilot data directory inside the repository.

A disposable browser rehearsal with fabricated credentials also completed the real HTTP and UI composition: unauthenticated
session status failed closed, one-time sign-in succeeded, create/panel/synthesis/promotion returned protected results,
the dynamic project page resolved, pause/resume advanced lifecycle version 1 to 3, and the same authenticated project
reappeared after a foreground process restart. The disposable database and server were removed afterward. This confirms
the wiring but is not a substitute for the owner's Keychain-backed run.

- CR12B combined gate: 51/51 passing;
- full repository lifecycle: 769/769 pretests, 414/416 core tests with zero failures and two intentional platform
  skips, and 129/129 posttests;
- TypeScript and full lint: passing;
- production build: passing with no browser externalization warnings;
- rendered routes: 3/3 passing;
- migrations: 30 files and 108 PostgreSQL tables verified;
- macOS stage zero: `ready_for_runtime_check`; and
- whitespace validation: passing.

## Pending owner evidence

The owner must personally run `docs/CR12B_IDEA_060_OWNER_PACKET.md`, approve any Keychain confirmation, enter the
one-time code, inspect the visible create-to-project and lifecycle flow, reload, restart the foreground server, and
report only the sanitized result. Until that happens, CR12B-IDEA-060 is not complete and the runtime is not accepted for
ordinary use.

No owner code, cookie, Keychain secret, username, local data path, raw host identity, screenshot containing private
values, live provider result, external network action, production database contact, deployment, or public effect is
accepted as evidence.
