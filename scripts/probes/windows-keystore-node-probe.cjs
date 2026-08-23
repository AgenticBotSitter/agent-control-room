// CR5C probe: Node 22 -> DPAPI via PowerShell child process (zero native deps).
// Observed evidence only; test vector is a constant, nothing persisted.
const { execFileSync } = require('child_process');
const PS = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const VECTOR = 'cr5c-node-bridge-vector';

function psRun(script) {
  return execFileSync(PS,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15000 }).trim();
}

try {
  const b64 = psRun(`
Add-Type -AssemblyName System.Security
$p=[Text.Encoding]::UTF8.GetBytes('${VECTOR}')
$e=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($e)`);
  console.log(`PS-child DPAPI protect from Node: OK (${Buffer.from(b64, 'base64').length}-byte blob)`);

  const out = psRun(`
Add-Type -AssemblyName System.Security
$e=[Convert]::FromBase64String('${b64}')
$d=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($d)`);
  console.log('unprotect roundtrip:', out === VECTOR ? 'OK' : `FAIL got "${out}"`);

  const t0 = Date.now();
  for (let i = 0; i < 5; i++) psRun(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('x'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`);
  console.log(`latency: ~${Math.round((Date.now() - t0) / 5)}ms per protect op (process-spawn dominated)`);
} catch (e) {
  console.log('FAIL:', String(e.message).slice(0, 300));
}
