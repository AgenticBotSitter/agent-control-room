# Contributor setup

Original code is licensed under Apache-2.0; third-party licenses remain applicable.
These instructions cover
the disposable local demo and synthetic integration tests, not a production installation.

## Requirements

- Node.js 22.13.0 or newer (current rehearsal: Node 22.22.3 on macOS).
- pnpm 11.19.0.
- Access to the public npm registry for dependencies not already cached.

From this source directory:

```sh
CI=true pnpm install --frozen-lockfile
pnpm check
pnpm check:demo
pnpm test:components
pnpm test:queue
pnpm test:demo
pnpm test:build:demo
pnpm test
```

If pnpm is not installed, `npx --yes pnpm@11.19.0` can replace `pnpm` in the commands
above. It may download the pinned package manager; do not substitute the newest release.
Keep the lockfile and disabled dependency-build policy unchanged.

In Windows PowerShell, set `$env:CI = "true"` and then run
`pnpm install --frozen-lockfile` instead of the Unix-style first line. The current
isolated rehearsal is on macOS; Windows and Linux installation acceptance is pending.

`pnpm check` checks the standalone TypeScript source. `pnpm test` builds the standalone
application and runs its selected compiled integration tests with synthetic/disposable
resources. It is not the full private-development test suite. No GitHub credentials,
agent authentication or production database should be supplied for these checks.

`pnpm test:components` runs the database, Access token, owner-signing, checkpoint,
Idea Lab, result-rendering, article/research, calendar and observation suites in sequence,
stopping on the first failed suite. This keeps the component checks discoverable
without GitHub Actions or overlapping database-heavy suites. It does not replace
`pnpm test`, the demo checks, workspace crash qualifications, real PostgreSQL
rehearsals, optional monitoring acceptance or live-agent/browser validation.

`pnpm test:ideas` exercises saved multi-perspective discussion, owner-only project
promotion and replay/uncertainty handling with an injected driver and one temporary
in-memory database. It does not connect to Hermes or Codex, and is not evidence
that a live fleet is operational.

`pnpm test:queue` runs the existing synthetic submission, pickup and worker-runtime
contracts: transaction routing, recovery-verifier refusal, cancellation, faults,
late callbacks and drain uncertainty. It uses fake engine/database ports, not a
running PostgreSQL service, and does not prove native crash recovery or role grants.

`pnpm test:owner-signing` checks signing ownership, cancellation and explicit
endpoint validation. It uses generated test keys, fake socket ports and one
owned temporary directory; it never discovers or connects to your SSH agent.
The optional pinned ssh2 protocol evaluation is separate and requires its logged
disposable package directory. Do not provide personal keys or SSH_AUTH_SOCK.
Passing these tests does not authorize activating the unwired native connector.

`pnpm test:checkpoints` checks the retained etcd adapter's exact-key read/write,
deadline, cancellation and uncertainty behavior through scripted RPC callbacks.
It requires no etcd installation or credentials. It does not prove independent
backup placement, authenticated service transport or split-commit recovery.

To compile without running the selected tests:

```sh
pnpm build
```

The output is `dist-vps`. A successful build does not configure a running application.
The operational launcher requires trusted operator configuration and real resources;
do not use it as a demo quick start or supply fake production credentials.

## Try the disposable demo

After preparing dependencies, run:

```sh
pnpm demo
```

The command builds the browser files and starts the demo at
`http://127.0.0.1:3000/local-preview`. It listens only on this computer. If port
3000 is occupied, stop your own conflicting server or use a separate session later;
the launcher will not stop another application or select a different port.

The terminal prints a one-time code after startup. Paste it into the page's
**One-time owner code** field. Keep it out of shared screenshots, logs and issues.
No Keychain access, agent credentials, paid provider or production database is needed.

Do not run the SQL files in `db/roles` to prepare this demo. Its temporary PGlite
database applies `db/migrations` itself. Role files are separate operator profiles,
not a single installation script: applying every profile can grant overlapping
permissions, and some require an already provisioned pg-boss queue. Never apply
them to an existing or shared database as part of contributor setup.

Create a project, save a proposed task, open it and choose **Simulate this task**.
Inspect the labelled sample, enter feedback and request a revised sample. Earlier
samples remain available; reopening the task reads history without rerunning work.
Feedback is reproduced as sample text, not executed by an agent.

Press Ctrl+C in the launch terminal to stop the server and remove this session's
temporary database. SIGTERM uses the same cleanup. A forced kill or crash can leave
temporary data; a cleanup warning means deletion was not confirmed. Do not store
important work in this demo. The current demo login lasts 15 minutes; after expiry,
restart for a fresh disposable session and code. This is not the planned production
login experience.

## Still awaiting acceptance

The demo command and its simulated flow pass automated tests and one local desktop
browser trial on macOS, including revision/history and shutdown cleanup. Keyboard,
mobile and other operating-system acceptance remain incomplete. There is no supported `pnpm dev` or
`pnpm start` command here. Hermes and Codex live compatibility, PostgreSQL deployment,
production owner login, approval key custody
and independent integrity storage require separate configuration and acceptance.

Tests of simulated behavior do not prove live-agent compatibility or production safety.
Do not publish this candidate as an operational release or run it against private data.

## Contributor workflow and cost

Run checks locally, use a branch per independently reviewable outcome, and batch
meaningful pushes and PR updates. Small local commits do not consume Actions minutes.
This candidate contains no GitHub Actions workflows. Never add scheduled jobs,
automatic deployment, secrets or self-hosted public-PR runners without maintainer review.

## Local cleanup

Stop any process you explicitly started before cleaning its data. Preserve your source
edits. Dependencies (`node_modules`) and generated output (`dist-vps` and
`dist-contributor`) can be recreated;
inspect exact paths before removing them. Do not delete a shared package cache, home
directory or another checkout. Temporary rehearsal logs are not release content.
