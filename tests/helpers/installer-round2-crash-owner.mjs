import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {remintOwnerCodeV1} from '../../src/updater/v1/install/stage-one-ports.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const {crashAt,...input}=JSON.parse(text);
if(crashAt){const rename=fs.rename;fs.rename=async(...args)=>{
  await rename(...args);
  const name={receipt:'owner-code-recovery.json',mac:'mac-local.json',session:'local-owner-session.json'}[crashAt];
  if(String(args[1]).endsWith('/'+name))process.kill(process.pid,'SIGKILL');
};syncBuiltinESMExports();}
await remintOwnerCodeV1(input);process.kill(process.pid,'SIGKILL');
