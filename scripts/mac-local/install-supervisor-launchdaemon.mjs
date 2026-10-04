import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Owner-run installer for the persistent M2 supervisor. This file is shipped
// but never invoked by build/test. A system LaunchDaemon (not a user agent) is
// required to survive logout and reboot; UserName keeps the service unprivileged.
import { execFile } from "node:child_process";
import { chmod, chown, copyFile, lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPERVISOR_LAUNCHD_LABEL_V1 = "xyz.agentcontrolroom.supervisor";
export const SUPERVISOR_LAUNCHD_PATH_V1 = `/Library/LaunchDaemons/${SUPERVISOR_LAUNCHD_LABEL_V1}.plist`;
const templatePath = fileURLToPath(new URL("../../deploy/macos/xyz.agentcontrolroom.supervisor.plist.in", import.meta.url));

const xml = value => value.replace(/[&<>"']/gu, character => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;" })[character]);
const absolute = value => typeof value === "string" && isAbsolute(value) && resolve(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value);

export function renderSupervisorLaunchDaemonV1(template, input) {
  if (typeof template !== "string" || !absolute(input.nodeExecutable) || !absolute(input.repositoryRoot)
    || !absolute(input.protectedRoot) || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(input.serviceUser))
    throw new Error("supervisor_launchdaemon_input_invalid");
  const values = { __NODE_EXECUTABLE__:input.nodeExecutable,__REPOSITORY_ROOT__:input.repositoryRoot,
    __PROTECTED_ROOT__:input.protectedRoot,__SERVICE_USER__:input.serviceUser };
  return template.replace(/__[A-Z_]+__/gu, placeholder => {
    if (!Object.hasOwn(values, placeholder)) throw new Error("supervisor_launchdaemon_template_invalid");
    return xml(values[placeholder]);
  });
}

const run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{encoding:"utf8",timeout:90_000},
  (error,stdout)=>error?reject(error):resolve(stdout)));
const succeeds=(file,args)=>new Promise(resolve=>execFile(file,args,{encoding:"utf8",timeout:90_000},
  error=>resolve(!error)));

async function main(){
  if(process.getuid?.()!==0)throw new Error("run this installer as root");
  const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const serviceUser=value("--service-user"),repositoryRoot=value("--repository-root"),protectedRoot=value("--protected-root"),
    nodeExecutable=value("--node-executable");
  if(!serviceUser||serviceUser==="root"||!repositoryRoot||!protectedRoot||!nodeExecutable)
    throw new Error("usage: --service-user NAME --repository-root ABSOLUTE_PATH --protected-root ABSOLUTE_PATH --node-executable ABSOLUTE_PATH");
  const [repo,node,root]=await Promise.all([realpath(repositoryRoot),realpath(nodeExecutable),realpath(protectedRoot)]);
  const runtime=await realpath(join(root,"runtime")),host=await realpath(join(repo,"scripts/mac-local/task-host-supervisor.mjs"));
  const [repoEntry,nodeEntry,rootEntry,runtimeEntry,hostEntry]=await Promise.all(
    [repo,node,root,runtime,host].map(path=>lstat(path)));
  const serviceUid=Number((await run("/usr/bin/id",["-u",serviceUser])).trim());
  if(!Number.isSafeInteger(serviceUid)||serviceUid<1||!repoEntry.isDirectory()||!nodeEntry.isFile()
    ||(nodeEntry.mode&0o111)===0||!rootEntry.isDirectory()||rootEntry.isSymbolicLink()||(rootEntry.mode&0o077)!==0
    ||rootEntry.uid!==serviceUid||!runtimeEntry.isDirectory()||runtimeEntry.isSymbolicLink()||(runtimeEntry.mode&0o077)!==0
    ||runtimeEntry.uid!==serviceUid||!hostEntry.isFile()||hostEntry.isSymbolicLink())throw new Error("supervisor launch daemon paths unsafe");
  const body=renderSupervisorLaunchDaemonV1(await readFile(templatePath,"utf8"),
    {serviceUser,nodeExecutable:node,repositoryRoot:repo,protectedRoot:root});
  const temporary=`${SUPERVISOR_LAUNCHD_PATH_V1}.new-${process.pid}`;
  try{await lstat(SUPERVISOR_LAUNCHD_PATH_V1);if(!args.includes("--replace"))throw new Error("launch daemon already exists; pass --replace after reviewing it");
    await copyFile(SUPERVISOR_LAUNCHD_PATH_V1,`${SUPERVISOR_LAUNCHD_PATH_V1}.previous`);}catch(error){
    if(error?.code!=="ENOENT"&&!String(error?.message).includes("already exists"))throw error;
    if(String(error?.message).includes("already exists"))throw error;}
  try{await writeFile(temporary,body,{encoding:"utf8",mode:0o600,flag:"wx"});await chmod(temporary,0o600);await chown(temporary,0,0);
    await rename(temporary,SUPERVISOR_LAUNCHD_PATH_V1);}catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
  if(await succeeds("/bin/launchctl",["print",`system/${SUPERVISOR_LAUNCHD_LABEL_V1}`]))
    await run("/bin/launchctl",["bootout",`system/${SUPERVISOR_LAUNCHD_LABEL_V1}`]);
  await run("/bin/launchctl",["bootstrap","system",SUPERVISOR_LAUNCHD_PATH_V1]);
  console.log(`installed ${SUPERVISOR_LAUNCHD_LABEL_V1}`);
}

if(isMainModuleV1(process.argv[1], import.meta.url))void main().catch(error=>{
  console.error(error instanceof Error?error.message:"supervisor install failed");process.exitCode=1;});
