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
files: `git ls-files --eol | grep -c "w/crlf"` must print `0` (re-verified `0`
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
git ls-files --eol | Select-String 'w/crlf'   # expect no output
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
