import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Source and output remain siblings even when TMPDIR is inside the checkout.
// Copy this run's real built artifact; omit node_modules and Git state.
export async function releaseSourceFixtureV1(repository, target) {
  await mkdir(target);
  for (const name of ['src','scripts','db','deploy','dist-vps','research','third_party',
    'LICENSE','NOTICE','THIRD_PARTY.md','package.json','pnpm-lock.yaml']) {
    await cp(join(repository,name),join(target,name),{recursive:true,errorOnExist:true,force:false});
  }
  return target;
}
