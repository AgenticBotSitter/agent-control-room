import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {generateInstallationReleaseKeyV1} from '../../scripts/release-signing.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const {name,...input}=JSON.parse(text);
const link=fs.link;
fs.link=async(...args)=>{await link(...args);if(String(args[1]).endsWith('/'+name))process.kill(process.pid,'SIGKILL');};
syncBuiltinESMExports();
await generateInstallationReleaseKeyV1(input,{expectedUid:process.geteuid()});
