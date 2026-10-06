import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async (...args) => {
  const handle = await original(...args);
  if (String(args[0]).includes('.staging-')) {
    const originalSync = handle.sync;
    handle.sync = async () => {
      process.stdout.write('SCRATCH_WRITTEN\n');
      const keepAlive = setInterval(() => {}, 1000);
      await new Promise(resolve => process.stdin.once('data', resolve));
      clearInterval(keepAlive);
      process.stdin.destroy();
      await originalSync.call(handle);
    };
  }
  return handle;
};
syncBuiltinESMExports();
const { ResultUploadStagingV1 } = await import('../../src/artifacts/v1/result-upload-staging.ts');
const staging = await ResultUploadStagingV1.create({rootPath:process.env.FILES3_STAGING_ROOT,
  maximumChunkBytes:1048576,operationTimeoutMs:10000});
await staging.stage({tenantId:'tenant:crash',projectId:'project:crash',
  uploadId:process.env.FILES3_UPLOAD_ID,ordinal:1},Buffer.alloc(1048576,65));
