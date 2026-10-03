import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { abortAttendedV1, buildFixedBundleV1, buildReleaseV1, fetchVerifiedSourceV1 } from '../../src/updater/v1/attended-source.mjs';
export const scratch = resolve('.test-tmp/r6u-fixtures');
export const digest = b => 'sha256:'+createHash('sha256').update(b).digest('hex');
export async function writableRemove(root) {
  async function walk(path) {
    const info=await lstat(path).catch(()=>null); if(!info || info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory()?0o700:0o600);
    if(info.isDirectory()) for(const name of await readdir(path)) await walk(join(path,name));
  }
  await walk(root); await rm(root,{recursive:true,force:true});
}
export async function newRoot(t, prefix='probe') {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(join(scratch,prefix+'-')); t.after(()=>writableRemove(root));
  for(const name of ['updater-state/plans','updater-state/confirmations','build','releases','updater','runtime','pg']) await mkdir(join(root,name),{recursive:true});
  await writeFile(join(root,'updater-state/self-update'),'Off\n',{mode:0o600}); return root;
}
export async function authorize(root,{planDigest}) {
  const {planId}=JSON.parse(await readFile(join(root,'updater-state/open-confirmation.json'),'utf8'));
  await writeFile(join(root,`updater-state/confirmations/${planId}.json`),JSON.stringify({planId,planDigest,confirmed:true}));
}
export async function sourceFixture(t,{version='1.0.0',commit='a'.repeat(40),existingRoot}={}) {
  const root=existingRoot??await newRoot(t,'source');
  const files=new Map([
    ['package.json',Buffer.from(JSON.stringify({name:'control-room',version}))],
    ['src/updater/v1/updater.mjs',Buffer.from('export const standIn=true;\n')],
    ['scripts/updater/build-fixed-updater-bundle.mjs',Buffer.from('export const standIn=true;\n')],
    ['scripts/release-signing.mjs',Buffer.from('export const standIn=true;\n')],
    ['src/pg-runtime/v1/pg-cluster-layout.ts',Buffer.from('export const standIn=true;\n')],
    // r5bk's recency reader and r7journal's jsonl-prefix are staged inputs too.
    ['src/installer/v1/nightly-backup-recency.ts',Buffer.from('export const standIn=true;\n')],
    ...['is-main-module','strict-json','rehearsal-hostname','file-custody','private-process-lock','jsonl-prefix'].map(n=>[`src/installer/shared/${n}.mjs`,Buffer.from('export const standIn=true;\n')])
  ]);
  const oid=b=>createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
  const helper=join(root,'helper'), fakeGit=join(root,'fake-git.mjs'), token=join(root,'updater-state/github-read.token');
  if(!existingRoot){
    await writeFile(helper,'#!/bin/sh\nexit 0\n',{mode:0o500});
    await writeFile(token,'stand-in',{mode:0o600});
    await writeFile(fakeGit,`#!${process.execPath}\nimport {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';let text='';for await(const c of process.stdin)text+=c;for(const path of text.trim().split('\\n')){const b=await readFile(path);console.log(createHash('sha1').update(Buffer.from('blob '+b.length+'\\0')).update(b).digest('hex'));}\n`,{mode:0o500});
  }
  const calls=[];
  async function commandRunner(file,args,options={}) {
    calls.push({file,args});
    const result={stdout:'',stderr:'',code:0};
    if(args.includes('init')) await writeFile(join(args.at(-1),'HEAD'),'stand-in');
    else if(args.includes('rev-parse')) result.stdout='b'.repeat(40)+'\n';
    else if(args.includes('ls-tree')) result.stdout=[...files].map(([name,b])=>`100644 blob ${oid(b)}\t${name}\0`).join('');
    else if(args.includes('cat-file') && args.includes('-s')) result.stdout=String([...files.values()].find(b=>oid(b)===args.at(-1)).length);
    else if(args.includes('archive')) await writeFile(args.find(x=>x.startsWith('--output=')).slice(9),'stand-in');
    else if(file==='qa-tar') {
      const source=args.at(-1); for(const [name,b] of files) {const path=join(source,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,b,{mode:0o644});}
    } else if(file==='qa-build') {
      const output=join(dirname(options.cwd),'output'), b=Buffer.from(JSON.stringify({name:'control-room',version}));
      await writeFile(join(output,'package.json'),b,{mode:0o400});
      await writeFile(join(output,'RELEASE_MANIFEST.json'),JSON.stringify({schema:'control-room.attended-build-manifest/v1',commit,version,fileCount:1,byteCount:b.length,files:[{path:'package.json',sha256:digest(b),mode:0o400,bytes:b.length}]}),{mode:0o400});
    } else if(file==='qa-bundle') {
      const output=join(dirname(options.cwd),'bundle'), b=Buffer.from('export const standIn=true;\n'); await mkdir(output);
      await writeFile(join(output,'updater.mjs'),b,{mode:0o500});
      await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'control-room.updater-bundle-manifest/v1',files:[{path:'updater.mjs',sha256:digest(b),mode:0o500,type:'file'}]}),{mode:0o400});
    } else if(args.includes('diff-tree')) result.stdout='src/app.mjs\0';
    return result;
  }
  const input={root,commit,remoteUrl:'https://github.com/fixture/control-room.git',credentialPath:token,
    identities:{rootUid:process.getuid(),rootGid:process.getgid(),builderUid:process.getuid(),builderGid:process.getgid(),serviceGid:process.getgid(),builderAccount:'_fixturebuild'},
    tools:{git:fakeGit,tar:'qa-tar',helper,node:process.execPath,pnpm:process.execPath,buildEntry:'qa-build',bundleEntry:'qa-bundle'},
    trustedRuntimeVerifier:async()=>({}),builderProcessControl:{listPids:async()=>[],hasScheduledEntries:async()=>false,killPid:async()=>{throw Error('unexpected kill');}},
    changeOwnership:async()=>{},commandRunner,fetchSteps:[],buildSteps:[{file:'qa-build',args:[]}],bundleFetchStep:null,bundleStep:{file:'qa-bundle',args:[]},authorize:value=>authorize(root,value)};
  let fetched; t.after(async()=>{if(fetched) await abortAttendedV1(fetched).catch(()=>{});});
  async function build() { fetched=await fetchVerifiedSourceV1(input);const release=await buildReleaseV1({...input,...fetched});const bundle=await buildFixedBundleV1({...input,...fetched});return{fetched,release,bundle}; }
  return {root,input,calls,build};
}
export async function initialPair(root) {
  await mkdir(join(root,'releases/2.0.0-old'));await writeFile(join(root,'releases/2.0.0-old/RELEASE_MANIFEST.json'),JSON.stringify({version:'2.0.0',commit:'c'.repeat(40)}));await mkdir(join(root,'updater/2.0.0-old'));
  await symlink('releases/2.0.0-old',join(root,'current'));await symlink('2.0.0-old',join(root,'updater/current'));
}
