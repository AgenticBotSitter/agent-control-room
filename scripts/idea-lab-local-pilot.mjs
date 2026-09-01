#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const command=process.argv[2],attended=process.argv.includes("--owner-attended"),repositoryRoot=process.cwd();
const pilotRoot=resolve(homedir(),"Library/Application Support/Agent Control Room/local-pilot"),activePath=resolve(pilotRoot,"active.json");
function fail(message){process.stderr.write(`${message}\n`);process.exitCode=1;}
function digest(code){return`sha256:${createHash("sha256").update(JSON.stringify({code})).digest("hex")}`;}
async function config(){const parsed=JSON.parse(await readFile(activePath,"utf8"));if(!parsed||parsed.contractVersion!=="control-room-local-pilot-launch/v1")throw new Error("local pilot configuration is invalid");return parsed;}

if(command==="prepare"){
  if(process.platform!=="darwin")fail("The owner-attended local pilot is macOS-only.");
  else if(!attended)fail("Run prepare yourself with --owner-attended; an agent cannot assert owner presence.");
  else{const runId=randomBytes(12).toString("hex"),ownerCode=randomBytes(24).toString("base64url"),master=randomBytes(32).toString("base64"),account=userInfo().username,
    service=`xyz.agentcontrolroom.local-pilot.${runId}`,dataDir=resolve(pilotRoot,"runs",runId);
    await mkdir(dataDir,{recursive:true,mode:0o700});await chmod(dataDir,0o700);
    const stored=spawnSync("/usr/bin/security",["add-generic-password","-U","-a",account,"-s",service,"-w",master],{stdio:["ignore","ignore","inherit"]});
    if(stored.status!==0)fail("macOS Keychain did not accept the local-pilot master key.");
    else{const value={contractVersion:"control-room-local-pilot-launch/v1",runId,mode:"repository_fake",origin:"http://127.0.0.1:3000",dataDir,
      ownerCodeDigest:digest(ownerCode),keychain:{account,service},createdAt:new Date().toISOString(),liveProviderAuthorized:false,productionAuthorized:false};
      await mkdir(pilotRoot,{recursive:true,mode:0o700});await writeFile(activePath,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});await chmod(activePath,0o600);
      process.stdout.write(`Local repository-fake pilot prepared.\n\nOne-time owner code (shown once): ${ownerCode}\n\nNext: npm run pilot:idea:start -- --owner-attended\n`);}}
}else if(command==="start"){
  if(process.platform!=="darwin")fail("The owner-attended local pilot is macOS-only.");
  else if(!attended)fail("Run start yourself with --owner-attended; an agent cannot assert owner presence or approve Keychain.");
  else{let value;try{value=await config();}catch{fail("Prepare the local pilot first.");}
    if(value){const found=spawnSync("/usr/bin/security",["find-generic-password","-a",value.keychain.account,"-s",value.keychain.service,"-w"],{encoding:"utf8",stdio:["ignore","pipe","inherit"]}),master=found.stdout?.trim();
      if(found.status!==0||!master||Buffer.from(master,"base64").byteLength!==32)fail("The protected local-pilot master key was unavailable.");
      else{process.stdout.write("Starting Control Room on http://127.0.0.1:3000/ideas\nRepository-fake panel only. Press Control-C to stop.\n");
        const child=spawn(resolve(repositoryRoot,"node_modules/.bin/vinext"),["dev","--hostname","127.0.0.1","--port","3000"],{cwd:repositoryRoot,stdio:"inherit",env:{...process.env,
          CONTROL_ROOM_LOCAL_PILOT_MODE:"repository_fake",CONTROL_ROOM_LOCAL_PILOT_DATA_DIR:value.dataDir,
          CONTROL_ROOM_LOCAL_PILOT_OWNER_CODE_DIGEST:value.ownerCodeDigest,CONTROL_ROOM_LOCAL_PILOT_MASTER_KEY_B64:master}});
        const stop=signal=>{if(!child.killed)child.kill(signal);};process.once("SIGINT",()=>stop("SIGINT"));process.once("SIGTERM",()=>stop("SIGTERM"));
        child.once("exit",(code,signal)=>{process.exitCode=code??(signal?1:0);});}}
  }
}else if(command==="status"){
  try{const value=await config();process.stdout.write(`${JSON.stringify({configured:true,runId:value.runId,mode:value.mode,origin:value.origin,
    createdAt:value.createdAt,liveProviderAuthorized:false,productionAuthorized:false},null,2)}\n`);}catch{process.stdout.write(`${JSON.stringify({configured:false},null,2)}\n`);}
}else fail("Usage: idea-lab-local-pilot.mjs prepare|start|status [--owner-attended]");
