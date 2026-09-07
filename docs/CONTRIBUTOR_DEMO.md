# Local contributor demo

This is a disposable simulation, not a connection to Hermes, Codex or a live
provider. It uses the existing project/task interface and a temporary local
database. Sample results do not prove that a real agent completed a task.

## Start

Use Node 22.13 or newer and the repository's pinned pnpm 11.19.0. Follow
[checkout preparation](WORKER_CHECKOUT_PREPARATION.md) first. Then, from the
repository directory, explicitly run:

```sh
pnpm demo
```

This builds the demo and starts it at `http://127.0.0.1:3000/local-preview`.
Only this computer's loopback address is used. No server is installed as a
background service. If port 3000 is occupied, startup fails without trying a
different port or stopping another application.

After successful startup, the terminal prints a one-time login code. Copy it
into the owner login field on the demo page. Keep it private; do not paste it
into an issue, screenshot, shared terminal log or commit. No Keychain access,
existing agent authentication or production database is required.

Create a project and proposed task, then explicitly choose the simulation action
to obtain a clearly labelled sample result. Real execution is not enabled.
Revision flow and browser acceptance are still being completed; this document
describes the implemented command, not a claim that the release is ready.

## Stop

Press Ctrl+C in the same terminal. The launcher stops accepting requests, drains
work and removes its temporary demo data. SIGTERM uses the same cleanup. Each
fresh launch creates a new session and code; do not use this demo to store work
you need to keep. Forced termination or a machine crash can leave temporary
data behind. A cleanup warning must not be treated as successful deletion.

## Verify without opening a listener

```sh
pnpm test:demo
pnpm test:build:demo
```

These use fake servers or in-memory request exchanges. They do not establish
that an actual browser/network session works; that acceptance remains separate.
