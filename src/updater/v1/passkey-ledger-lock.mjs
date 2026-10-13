import { acquireKernelFileLockV1 } from "../../installer/shared/private-process-lock.mjs";

/** Lock the caller-supplied permanent ledger lock path. The enclosing directory
 * must satisfy kernel lock custody. S0 supplies exclusion only; ledger format,
 * reconciliation and production caller integration belong to later slices. */
export async function acquirePasskeyLedgerLockV1(path, { expectedUid = process.getuid() } = {}) {
  return acquireKernelFileLockV1(path, { expectedUid,
    busyCode: "passkey_ledger_lock_busy", refusedCode: "passkey_ledger_lock_refused" });
}
