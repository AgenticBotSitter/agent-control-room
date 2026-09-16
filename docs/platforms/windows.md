# Windows worker platform notes

Target: Windows 11, Node >= 22.13, pnpm 11.19.0 (`npx --yes pnpm@11.19.0`).
Verified on base `cf9197d` (`codex/component-batch-4`).

## 1. Checkout must be LF

Root `.gitattributes` pins `* text=auto eol=lf`. Default Windows checkouts
(LF→CRLF, no attributes) change worktree bytes, which shifts the pinned schema
digest `privateWebSchemaDigest` (`bb294b…`): migration SQL applied with CRLF
embeds `\r\n` in `pg_get_functiondef` / column defaults, so the preflight gate
(`verifyDatabase`, `private-database-preflight.ts:291`) refuses startup and the
`audit-required-hashes` test fails directly. After cloning, confirm zero CRLF
files: `git ls-files --eol | grep -cE "w/(crlf|mixed)"` must print `0` (re-verified `0`
on 2026-09-12 with `.gitattributes` pinned). If it does not, do NOT delete
tracked files inside a worktree that holds your changes. Confirm a clean slate
first (`git status --short` must be empty — commit or stash your work, never
discard it), then verify in a fresh isolated checkout that leaves the original
untouched (PowerShell):

```powershell
cd C:\opt\data\work
git clone --config core.autocrlf=false --config core.eol=lf <repo-url> agent-control-room-lfcheck
cd agent-control-room-lfcheck
git checkout <revision-under-test>
git ls-files --eol | Select-String 'w/(crlf|mixed)'   # expect no output
```

Plain `git checkout-index -f -a` and `git reset --hard` skip byte-identical
files and leave CRLF in place, which is why the isolated clone (rather than
in-place re-checkout) is required.

## 2. Install

```powershell
$env:CI='true'; npx --yes pnpm@11.19.0 install --frozen-lockfile
```
pnpm-on-Windows
hash-shortens 4 long peer-dir names under `node_modules/.pnpm`
(`css-calc`, `css-color-parser`, `css-parser-algorithms`, `react-markdown`).
The retained macOS inventory paths do not resolve here; do NOT regenerate the
retained input to pass — that is maintainer-owned (notice-packaging track).

## 3. Test status on Windows

`pnpm check`, `pnpm check:demo`: pass (exit 0; re-verified 2026-09-12).
`pnpm test:demo`: 30/30 pass (exit 0; re-verified 2026-09-12). `pnpm test`:
51/57 pass, 3 fail, 3 skipped — runner exit code **1** (re-verified 2026-09-12;
see §3.2). `pnpm test:components`: all suites pass; `test:observations` pane-port runs 1
Windows refusal assertion with 3 POSIX-only tests explicitly skipped.

### 3.1 Fixed by this branch

- Byte-pinned evidence: root `.gitattributes` (`* text=auto eol=lf`). Fixes the
  digest gate and 21 of 24 compiled failures (single root cause, not 21 bugs).
- `tests/herdr-pane-port.test.ts`: POSIX launch tests skip on win32; a Windows
  test asserts `observation_platform_unqualified` with native paths. No `src`
  change — the port stays unwired by design.

### 3.2 Explicitly platform-gated (not fixed here — needs maintainer decision)

- `vps-built-node-launcher` (test 24), `vps-built-startup` (tests 42, 46):
  `validatePrivateVpsConfigurationPath` (`scripts/run-private-vps.mjs:20`)
  requires `process.getuid`, which does not exist on Windows, so operator-config
  validation always throws `private_vps_configuration_invalid`. Re-verified
  2026-09-12: these are **failures** (runner totals 51 pass / 3 fail / 3
  skipped, exit 1), not skips — do not relabel them as passing gates. A Windows
  ownership equivalent (ACL check) is a security decision — do not weaken the
  POSIX gate to pass.
- `license-evidence` multi-text subtest: needs a symlink fixture in `%TEMP%`
  (Developer Mode/admin on Windows). Host limitation, no leftovers.
- Symlink fixture in `test:components`: same cause.

## 4. Demo on Windows

`npx --yes pnpm@11.19.0 demo` serves the disposable contributor demo on
`http://127.0.0.1:3000/local-preview` (one-time owner code, single use; pipe
stdout to a file to capture it). Full API flow verified server-side: login →
create → propose → simulate (`grantsExecutionAuthority:false`) → feedback
revision → 2-entry history. KILL (`taskkill /F /PID`) is not Ctrl+C: it leaves
`control-room-contributor-demo-*` (pglite) under `%TEMP%` — remove those exact
dirs afterward. Interactive-interrupt cleanup is untested (needs a console).

## 5. Not supported on Windows in this milestone

Native Herdr/owner-signing ports (darwin/linux-only by design), live
Hermes/Codex execution (separate gate), production DB, machine-wide cleanup.

## 6. PowerShell preparation probe

`node scripts/windows/check-windows-preparation.mjs` spawns a fixed PowerShell
probe (`scripts/windows/windows-preparation-probe.ps1`) with the safe flags
`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`, bounded
output (`maxBuffer: 64 KiB`) and a 60 s timeout. The probe inspects
already-installed tools only:

- PowerShell version
- `node --version`
- `pnpm --version`

It never downloads code: `npx --yes pnpm@...` is forbidden in the probe
because on an unprepared machine it would fetch and execute remote code and
write to the npm cache. Installing or upgrading tools is a separate,
explicitly authorized step. DPAPI is deliberately not probed — MVP worker
preparation neither uses nor verifies it, and loading `System.Security`
alone would not verify `CurrentUser` operation.

The probe reports one `key: value` line per tool; the classifier
(`scripts/windows/classify-preparation-result.mjs`) validates every
capability and its minimum version (Node `>= 22.13.0`, pnpm `>= 11.19.0`).
A missing tool or an under-minimum version is `missing`, never `available`.
The probe never invokes a harness, never reads credentials, and never makes
a native effect. Exit codes come from the single canonical table in
`scripts/windows/windows-exit-codes.mjs`, shared with the line-endings and
launcher scripts (`src/node-policy/v1/types.ts:keyAvailabilityStates`):

| Exit | Category |
|---|---|
| 0 | available — every required tool/version verified |
| 1 | missing — required capability absent or below minimum |
| 2 | locked — PowerShell failed / signal / timeout / empty stdout |
| 3 | corrupt — probe script missing on disk |
| 4 | unavailable_platform — PowerShell itself not on PATH |
| 5 | permission_denied — the OS refused the spawn (EACCES/EPERM) |
| 6 | interaction_required (reserved) |

## 7. Supported launcher modes

`node scripts/windows/decide-launcher-mode.mjs <mode>` returns one of:

| Mode | Decision | Reason |
|---|---|---|
| `contributor-demo` | available | Disposable pglite demo on `127.0.0.1:3000/local-preview` |
| `remote-worker-prep` | available | Preparation probe only (this package) |
| `production-server` | refused | unavailable_platform — Linux is the initial production target |
| `posix-vps-custody` | refused | unavailable_platform — POSIX `getuid`-only path |
| `live-harness-launch` | refused | permission_denied — native harness activation is Q2/Q3/Q6 gated |
| anything else | refused | corrupt — closest canonical member for malformed input |

Use `decideLauncherMode(mode)` from the module to gate Windows automation
without spawning a child. CLI exit codes come from the same canonical table
(`scripts/windows/windows-exit-codes.mjs`), so callers match on one mapping:

| Reason | Exit |
|---|---|
| available | 0 |
| unavailable_platform | 4 |
| permission_denied | 5 |
| corrupt | 3 |

## 8. Cleanup ledger (Windows-specific)

Per `ziggy-machine-profile` §6, every disposable Windows artifact must be
individually removed and listed. On Windows this means:

- File deletion: `unlinkSync` after `lstat` check for symlink, never a
  wildcard `rm -rf *`.
- For a dir created with `mkdtempSync`: `rmSync(scratchDir, {
  recursive: true, force: true })` after every `unlinkSync` inside has
  succeeded.
- `forceDelete` is forbidden — if a file is locked, stop and report, do not
  retry with stronger primitives.
- `%TEMP%` hygiene: any probe creating dirs there must list them in the
  packet's side-effect ledger and prove removal.
- No reparse points, symlinks, junctions as cleanup targets — resolve and
  inspect first.

Tests use `mkdtempSync(join(tmpdir(), "windows-*"))` with `rmSync` in a
`finally` block, so leftover dirs are reported as test failures, not as
silent host pollution.

## 9. Test lane coverage

| Lane | Command | Files |
|---|---|---|
| `test:windows-preparation` | `node --test tests/windows-preparation.test.mjs` | 16 unit tests for `classify-preparation-result.mjs` + the shared exit table |
| `test:windows-line-endings` | `node --test tests/windows-line-endings.test.mjs` | 7 tests; spawns the script against disposable fixture repos (LF, CRLF, mixed) |
| `test:windows-launcher-modes` | `node --test tests/windows-launcher-modes.test.mjs` | 9 tests for `decide-launcher-mode.mjs` |

All three lanes are pure ESM (`.mjs`); no `tsx` import required.
