import {main} from '../../scripts/fleet/connector.mjs';
let peak=0;
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(...args)=>{
  const result=write(...args);
  peak=Math.max(peak,process.stdout.writableLength);
  return result;
};
const errorWrite=process.stderr.write.bind(process.stderr);
process.stderr.write=(text,...args)=>errorWrite(text ? JSON.stringify({reason:String(text).trim(),peak})+'\n' : text,...args);
await main(['mcp','--config',process.argv[2],'--workspace',process.argv[3]],undefined,{replyTimeoutMs:100});
