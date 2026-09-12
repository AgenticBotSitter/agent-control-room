# Install a Control Room release (operator guide)

Base revision model: one exact git SHA per release. The artifact is the repo
checkout at that SHA plus the `dist-vps/` build tree plus
`dist-release/manifest.json` (sha256 of every built file). Templates here are
generic examples — substitute your own paths, ports and secrets. Nothing in
this guide starts a service for you; each step is a command you run.

## 1. Prepare the machine

- Node.js >= 22.13.0 and pnpm 11.19.0 (`pnpm --version` must print `11.19.0`).
- A private host you control. The server binds loopback (`127.0.0.1`) only;
  public access is explicitly out of scope for this guide.
- PostgreSQL 17 reachable with the role your operator configuration names, and
  an R2-compatible bucket for files/backups. Roles, migrations and bucket
  creation are Codex-reviewed operations — they are NOT performed by the
  release scripts and are not covered here beyond the checklist pointers.

## 2. Build the release

```sh
git clone <your-fork> control-room && cd control-room
git checkout <exact-40-hex-sha>
CI=true pnpm install --frozen-lockfile
node scripts/build-vps.mjs            # produces dist-vps/
node scripts/release/build-release.mjs --revision <same-sha>
node scripts/release/verify-artifact.mjs
```

`build-release.mjs` refuses before any effect when `dist-vps/` is missing, the
revision is not a 40-hex SHA, the passed revision is not exactly the checkout's
current clean Git `HEAD` (the manifest proves build provenance), or
`dist-release/` already exists (pass `--overwrite` to replace). Record the
manifest's `revision` and `totalBytes` in your install log.

## 3. Write the operator configuration

Copy `examples/release/operator-config.example.mjs` to an absolute path OUTSIDE
the repo (for example `/home/operator/control-room-config.mjs`) and fill in
your values. The file must be owned by the service UID, mode `0600`, not a
symlink. Never commit it.

## 4. Preflight, then start

```sh
node scripts/release/preflight.mjs --configuration /home/operator/control-room-config.mjs --artifact dist-release
# Optional explicit bind probe (opens a listener — an effect):
node scripts/release/preflight.mjs --configuration /home/operator/control-room-config.mjs --artifact dist-release --port <port> --bind-probe
node scripts/run-private-vps.mjs --configuration /home/operator/control-room-config.mjs
```

Static preflight makes no listener effect: it checks versions, config-file
custody and artifact integrity, and exits 1 with a failure list when anything
is wrong. The loopback bind probe is opt-in (`--bind-probe`) because opening
a listener is a real effect. Preflight validates the config FILE, not what a
running process would load from it — the runtime's own validators re-check
every loaded value at startup. Do not start when preflight fails. See
`supervisor.md` for the unprivileged service template and
`restore-checklist.md` before first start against real data.

## 5. Live-start gate (separately approved)

A template passing preflight is NOT evidence production is operational. Live
start against real data requires the maintainer's explicit gate approval for
your revision (see issue #12). Until then, run against disposable data only.
