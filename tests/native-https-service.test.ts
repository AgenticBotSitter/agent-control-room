import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeHttpsService } from "../src/web/v1/native-https-service";

async function ownedCommand(t: test.TestContext, executable: string, args: string[], cwd: string) {
  const child=spawn(executable,args,{cwd,detached:true,env:process.env,stdio:["ignore","pipe","pipe"]});
  let finished=false,output="";
  child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
  const killGroup=()=>{try{process.kill(-child.pid!,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}};
  t.after(()=>{if(!finished)killGroup();});
  const status=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  finished=true;killGroup();assert.equal(status,0,output);
}

async function tlsFixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),"native-https-default-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const caKey=join(root,"ca.key"),ca=join(root,"ca.crt"),serverKey=join(root,"server.key");
  const csr=join(root,"server.csr"),serverCert=join(root,"server.crt"),extensions=join(root,"server.ext");
  await writeFile(extensions,"subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  await ownedCommand(t,"openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",caKey,"-out",ca,
    "-subj","/CN=Control Room Test CA","-days","1"],root);
  await ownedCommand(t,"openssl",["req","-newkey","rsa:2048","-nodes","-keyout",serverKey,"-out",csr,
    "-subj","/CN=127.0.0.1"],root);
  await ownedCommand(t,"openssl",["x509","-req","-in",csr,"-CA",ca,"-CAkey",caKey,"-CAcreateserial",
    "-out",serverCert,"-days","1","-sha256","-extfile",extensions],root);
  return {key:await readFile(serverKey),cert:await readFile(serverCert),ca:await readFile(ca)};
}

async function freePort() {
  const server=createNetServer();server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;
}

function requestWithoutClientCertificate(port: number, ca: Buffer) {
  return new Promise<Error>((resolve,reject)=>{
    const outbound=request({host:"127.0.0.1",port,path:"/",method:"GET",ca,rejectUnauthorized:true,agent:false},
      response=>{response.resume();reject(new Error(`unexpected response ${response.statusCode}`));});
    outbound.once("error",error=>resolve(error));outbound.end();
  });
}

test("item 15: the default native HTTPS server refuses no-certificate clients under burst and closes a slow socket",async t=>{
  const tls=await tlsFixture(t),port=await freePort();let handled=0,closed=0;
  const service=createNativeHttpsService({host:"127.0.0.1",port,...tls,application:{isReady:()=>true,
    async handleNode(_request,response){handled+=1;response.writeHead(200);response.end();},async close(){closed+=1;}}});
  t.after(()=>service.close().catch(()=>{}));
  await service.start();assert.equal(service.isReady(),true);
  const refusals=await Promise.all(Array.from({length:20},()=>requestWithoutClientCertificate(port,tls.ca)));
  assert.ok(refusals.every(error=>error instanceof Error));assert.equal(handled,0);

  const slow=createConnection({host:"127.0.0.1",port});slow.on("error",()=>{});await once(slow,"connect");
  const slowClosed=new Promise<void>(resolve=>slow.once("close",()=>resolve()));
  await service.close();await slowClosed;assert.equal(service.isReady(),false);assert.equal(closed,1);assert.equal(slow.destroyed,true);
});

test("item 15 hostile: the default native HTTPS server reports a bind collision and closes its application",async t=>{
  const tls=await tlsFixture(t),occupied=createNetServer();occupied.listen(0,"127.0.0.1");await once(occupied,"listening");
  t.after(()=>new Promise<void>(resolve=>occupied.close(()=>resolve())));
  const address=occupied.address();assert.ok(address&&typeof address!=="string");let closed=0;
  const service=createNativeHttpsService({host:"127.0.0.1",port:address.port,...tls,application:{isReady:()=>true,
    async handleNode(){assert.fail("a failed bind cannot handle a request");},async close(){closed+=1;}}});
  await assert.rejects(service.start(),/native_https_service_start_failed/u);assert.equal(service.isReady(),false);assert.equal(closed,1);
});
