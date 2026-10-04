// The result-file store and the upload staging area take their locks with the
// BSD `O_EXLOCK` open flag (src/artifacts/v1/result-file-store.ts and
// result-upload-staging.ts). macOS honours it. Linux has no such flag: the
// kernel ignores the bit, the store's own probe sees a second lock granted, and
// staging refuses an unsupported kernel by name. So on a Linux host neither
// opens any root, which is the fail-closed answer, not a missing feature: a
// store that cannot exclude a second writer must not pretend it can.
//
// A case that needs an open store or staging area therefore runs its macOS body
// where the kernel lock exists, and proves that refusal everywhere else, rather
// than skipping (a skip would read as "nothing to check" on the Linux lanes).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext, type TestOptions } from "node:test";
import { ResultFileStoreError, ResultFileStoreV1 } from "../../src/artifacts/v1/result-file-store";
import { ResultUploadStagingError, ResultUploadStagingV1 } from "../../src/artifacts/v1/result-upload-staging";

/** True where the kernel honours `O_EXLOCK`, so the store and staging can open. */
export const KERNEL_OPEN_LOCK_HOST_V1 = process.platform === "darwin";

/** Both stores refuse a fresh private root, by code, and leave nothing in it. */
export async function assertResultStoresRefuseWithoutKernelOpenLockV1(): Promise<void> {
  assert.equal(KERNEL_OPEN_LOCK_HOST_V1, false, "only a host without O_EXLOCK proves the refusal");
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-no-exlock-")));
  try {
    const storeRoot = join(base, "store"), stagingRoot = join(base, "staging");
    await mkdir(storeRoot, { mode: 0o700 });
    await mkdir(stagingRoot, { mode: 0o700 });
    await assert.rejects(ResultFileStoreV1.create({ rootPath: storeRoot, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 5_000 }),
    (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_invalid",
    "without a kernel O_EXLOCK the result-file store must refuse its root");
    await assert.rejects(ResultUploadStagingV1.create({ rootPath: stagingRoot, maximumChunkBytes: 1_024,
      operationTimeoutMs: 5_000 }),
    (error: unknown) => error instanceof ResultUploadStagingError && error.code === "staging_invalid",
    "without a kernel O_EXLOCK the upload staging area must refuse its root");
    assert.deepEqual(await readdir(storeRoot), [], "a refused store leaves no probe or lock behind");
    assert.deepEqual(await readdir(stagingRoot), [], "a refused staging area writes nothing");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

type CaseBody = (t: TestContext) => unknown;

/** `test(name, [options], body)` for a case that needs an open store or staging
 * area: the body on a kernel-lock host, the refusal proof everywhere else. */
export function kernelOpenLockTestV1(name: string, ...rest: [CaseBody] | [TestOptions, CaseBody]): Promise<void> {
  const [options, body] = rest.length === 2 ? rest : [{}, rest[0]];
  return test(name, options, KERNEL_OPEN_LOCK_HOST_V1 ? body : assertResultStoresRefuseWithoutKernelOpenLockV1);
}
