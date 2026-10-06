import { installControlRoomV1 } from '../../src/updater/v1/install/installer.mjs';
import { fakePorts } from './installer-round2-fixture.mjs';
let text = '';
for await (const chunk of process.stdin) text += chunk;
const options = JSON.parse(text);
const ports = fakePorts({idStart: 800000});
const switchPair = ports.switchPairV1;
ports.switchPairV1 = async input => {
  const result = await switchPair(input);
  if (!input.restore) process.kill(process.pid, 'SIGKILL');
  return result;
};
await installControlRoomV1({...options, ports});
