import { randomUUID } from 'node:crypto';
import { installControlRoomV1 } from '../../src/updater/v1/install/installer.mjs';
import { fakePorts } from './installer-round2-fixture.mjs';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const { hold=false, ...options }=JSON.parse(text);
const ports=fakePorts({idStart: 900000, buildGate:async()=>{
  if(hold){process.stdout.write('entered\n'); await new Promise(resolve=>setTimeout(resolve, 1000));}
}});
ports.randomId=randomUUID;
try { process.stdout.write(JSON.stringify({state:(await installControlRoomV1({...options,ports})).state})+'\n'); }
catch(error){process.stderr.write(error.stack+'\n');process.stdout.write(JSON.stringify({state:error.code??error.message})+'\n');}
