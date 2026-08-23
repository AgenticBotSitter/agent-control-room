# CR5C Windows key-store capability probe - dry-run, non-destructive.
# No secrets persisted; all test vectors are in-memory constants.
$ErrorActionPreference = 'Stop'

Write-Output "=== DPAPI (ProtectedData) ==="
Add-Type -AssemblyName System.Security
$plain = [System.Text.Encoding]::UTF8.GetBytes("cr5c-probe-test-vector")
try {
  $ent = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null,
           [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($ent, $null,
           [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $ok = ([System.Text.Encoding]::UTF8.GetString($dec) -eq "cr5c-probe-test-vector")
  Write-Output ("CurrentUser roundtrip: " + $(if ($ok) {"OK"} else {"FAIL"}))
  Write-Output ("blob size: " + $ent.Length + " bytes")
} catch { Write-Output ("CurrentUser FAIL: " + $_) }

try {
  $b = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null,
          [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
  Write-Output ("LocalMachine scope: available (" + $b.Length + "-byte blob)")
} catch { Write-Output ("LocalMachine FAIL: " + $_) }

Write-Output ""
Write-Output "=== Credential Manager CredReadW P/Invoke type-load ==="
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class CMProbe {
  [DllImport("advapi32", CharSet=CharSet.Unicode)]
  public static extern bool CredReadW(string target, int type, int flags,
      out IntPtr credPtr, out int credSize);
}
'@
try { Add-Type -TypeDefinition $sig | Out-Null; Write-Output "advapi32!CredReadW load: OK" }
catch { Write-Output ("CredReadW load FAIL: " + $_) }

Write-Output ""
Write-Output "=== CNG/NCrypt provider inventory (metadata only) ==="
try {
  Get-ChildItem Cert:\CurrentUser\My | Select-Object -First 1 | Out-Null
  Write-Output "Cert:\CurrentUser\My readable: OK"
} catch { Write-Output ("Cert store read FAIL: " + $_) }
$tpm = Get-Tpm -ErrorAction SilentlyContinue
if ($tpm) { Write-Output ("TPM present: " + $tpm.TpmReady) } else { Write-Output "TPM: not queryable without elevation (documented)" }
