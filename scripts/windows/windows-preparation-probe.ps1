# Windows preparation probe — read-only, no harness invocation, no credentials.
#
# Outputs one key:value line per inspected tool. The probe always reports and
# exits normally; `check-windows-preparation.mjs` validates every reported
# version against its minimum and decides the outcome. Consumed by
# `scripts/windows/check-windows-preparation.mjs`.
#
# Read-only by construction: the probe inspects already-installed tools only.
# It never downloads or executes remote code (`npx --yes` is forbidden here —
# on an unprepared machine that would fetch and run code over the network and
# write to the npm cache). Installing or upgrading Node/pnpm is a separate,
# explicitly authorized preparation step, not part of this probe.
#
# DPAPI is deliberately NOT probed: MVP worker preparation neither uses nor
# verifies DPAPI, and loading System.Security alone would not verify
# CurrentUser operation. The classifier ignores any extra output lines.

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'

function Emit-Version([string]$Key, [string]$Version) {
  if ($Version) { Write-Output ("{0}: {1}" -f $Key, $Version) }
  else { Write-Output ("{0}: missing" -f $Key) }
}

# PowerShell version (we're running, so always present)
Emit-Version 'ps' $PSVersionTable.PSVersion.ToString()

# Node — required for the rest of the workspace (already-installed only)
try {
  $nodeOut = & node --version 2>$null
  if ($LASTEXITCODE -eq 0 -and $nodeOut) { Emit-Version 'node' ($nodeOut.Trim() -replace '^v', '') }
  else { Emit-Version 'node' 'missing' }
} catch { Emit-Version 'node' 'missing' }

# pnpm — already-installed only; a miss is reported, never fetched
try {
  $pnpmOut = & pnpm --version 2>$null
  if ($LASTEXITCODE -eq 0 -and $pnpmOut) { Emit-Version 'pnpm' ($pnpmOut.Trim()) }
  else { Emit-Version 'pnpm' 'missing' }
} catch { Emit-Version 'pnpm' 'missing' }
