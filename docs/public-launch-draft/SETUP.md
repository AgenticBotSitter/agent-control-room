# Contributor setup — local candidate

This candidate is not yet a published or licensed release. These instructions cover
source compilation and compiled synthetic integration tests, not a live installation.

## Requirements

- Node.js 22.13.0 or newer (current rehearsal: Node 22.22.3 on macOS).
- pnpm 11.19.0.
- Access to the public npm registry for dependencies not already cached.

From this source directory:

```sh
CI=true pnpm install --frozen-lockfile
pnpm check
pnpm test
```

If pnpm is not installed, `npx --yes pnpm@11.19.0` can replace `pnpm` in the commands
above. It may download the pinned package manager; do not substitute the newest release.
Keep the lockfile and disabled dependency-build policy unchanged.

`pnpm check` checks the standalone TypeScript source. `pnpm test` builds the standalone
application and runs its selected compiled integration tests with synthetic/disposable
resources. It is not the full private-development test suite. No GitHub credentials,
agent authentication or production database should be supplied for these checks.

To compile without running the selected tests:

```sh
pnpm build
```

The output is `dist-vps`. A successful build does not configure a running application.
The operational launcher requires trusted operator configuration and real resources;
do not use it as a demo quick start or supply fake production credentials.

## Not ready yet

The browser demonstration and its startup/shutdown instructions are not complete in
this candidate. There is no supported `pnpm dev` or `pnpm start` command here. Hermes
and Codex live compatibility, PostgreSQL deployment, owner login, approval key custody
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
edits. Dependencies (`node_modules`) and generated output (`dist-vps`) can be recreated;
inspect exact paths before removing them. Do not delete a shared package cache, home
directory or another checkout. Temporary rehearsal logs are not release content.
