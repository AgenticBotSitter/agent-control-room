"""Actual pinned synchronous SDK client with an authored stdio peer, never Codex."""
import json, sys

if len(sys.argv)>1 and sys.argv[1]=='--peer':
    import os
    mode=sys.argv[2]
    def emit(x):
        print(json.dumps(x),flush=True)
    def events(tid):
        for thread,delta in [(tid,'right'),('different-thread','wrong-thread')]:
            emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':'turn-fixture','itemId':'item-fixture','delta':delta}})
        emit({'method':'turn/completed','params':{'threadId':tid,'turn':{'id':'turn-fixture','items':[],'status':'completed'}}})
    for line in sys.stdin:
        msg=json.loads(line)
        method=msg.get('method')
        if method=='initialize':
            emit({'id':msg['id'],'result':{'userAgent':'synthetic-peer'}})
        elif method=='fixture/approvals':
            for index,name in enumerate(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/call','fixture/unknown']):
                emit({'id':f'approval-{index}','method':name,'params':{}})
                response=json.loads(sys.stdin.readline())
                if response.get('result')!={'decision':'decline'}:
                    raise RuntimeError('explicit refusal absent')
            emit({'id':msg['id'],'result':{'ok':True}})
        elif method=='turn/start':
            tid=msg['params']['threadId']; turn={'id':'turn-fixture','items':[],'status':'inProgress'}
            if mode=='early':events(tid)
            emit({'id':msg['id'],'result':{'turn':turn}})
        elif method=='fixture/emit':
            events('thread-fixture')
        elif method=='fixture/environment':
            emit({'id':msg['id'],'result':{'keys':sorted(os.environ),'marker':os.environ.get('SYNTHETIC_PARENT')}})
        elif method=='fixture/eof':
            break
        elif method=='fixture/malformed':
            print('not-json',flush=True); break
        elif method=='fixture/hold':
            continue
        elif method=='turn/interrupt':
            emit({'id':msg['id'],'result':{}})
    sys.exit(0)

import hashlib, pathlib, types, threading, time, os, signal
def timed_out(signum,frame):raise TimeoutError('15-second whole-experiment bound')
signal.signal(signal.SIGALRM,timed_out);signal.alarm(15)
root=pathlib.Path(sys.argv[1]); tree=root/'openai_codex'
receipt=json.loads(pathlib.Path('docs/research/reuse-comparisons/f2-client-acquisitions.json').read_text())
if root.is_symlink() or root.resolve()!=root: raise ValueError('root')
expected={r['file'] for r in receipt['files']}
entries=list(tree.rglob('*'))
if any(p.is_symlink() for p in entries) or {str(p.relative_to(tree)) for p in entries if p.is_file()}!=expected:
    raise ValueError('exact source tree')
for row in receipt['files']:
    if hashlib.sha256((tree/row['file']).read_bytes()).hexdigest()!=row['sha256']:raise ValueError('pin')
sys.dont_write_bytecode=True
for name,p in [('openai_codex',tree),('openai_codex.generated',tree/'generated')]:
    if name in sys.modules: raise ValueError('ambient module')
    m=types.ModuleType(name);m.__path__=[str(p)];sys.modules[name]=m
from openai_codex.client import CodexClient,CodexConfig
from pydantic import BaseModel,ConfigDict
class Reply(BaseModel):
    model_config=ConfigDict(extra='allow')
checks=[]; peers=[]; approvals=[]
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)
def refuse(method,params):
    approvals.append(method);return {'decision':'decline'}
def client(mode='normal'):
    c=CodexClient(CodexConfig(launch_args_override=(sys.executable,str(pathlib.Path(__file__).resolve()),'--peer',mode),cwd=str(root),env={'SYNTHETIC_OVERLAY':'yes'}),approval_handler=refuse)
    c.start();peers.append((c,c._proc));return c
try:
    c=client();check('actual initialize',c.initialize().userAgent=='synthetic-peer')
    check('four explicit server request refusals',c.request('fixture/approvals',{},response_model=Reply).ok and len(approvals)==4)
    stream=[];stream_errors=[]
    def consume(c,output,errors):
        try:output.extend(c.stream_text('thread-fixture','synthetic only'))
        except BaseException as e:errors.append(type(e).__name__)
    consumer=threading.Thread(target=consume,args=(c,stream,stream_errors),daemon=True);consumer.start()
    deadline=time.monotonic()+2
    while 'turn-fixture' not in c._router._turn_notifications and time.monotonic()<deadline:time.sleep(.005)
    check('stream registered before controlled peer emission','turn-fixture' in c._router._turn_notifications)
    c.notify('fixture/emit',{});consumer.join(2)
    check('controlled stream finished',not consumer.is_alive() and not stream_errors)
    check('actual typed stream includes wrong thread under same turn',[(x.thread_id,x.delta) for x in stream]==[('thread-fixture','right'),('different-thread','wrong-thread')])
    c.turn_interrupt('thread-fixture','turn-fixture');checks.append('actual interrupt response')
    env=c.request('fixture/environment',{},response_model=Reply)
    check('config env overlays parent rather than replaces',env.marker=='inherited-fixture' and 'SYNTHETIC_OVERLAY' in env.keys)
    early=client('early');early.initialize();early_output=[];early_errors=[]
    early_consumer=threading.Thread(target=consume,args=(early,early_output,early_errors),daemon=True);early_consumer.start()
    deadline=time.monotonic()+2
    while 'turn-fixture' not in early._router._turn_notifications and time.monotonic()<deadline:time.sleep(.005)
    check('early start response consumed and empty turn queue registered',
        'turn-fixture' in early._router._turn_notifications and early._router._turn_notifications['turn-fixture'].empty())
    early_consumer.join(.15)
    check('early terminal before start reply leaves stream waiting',early_consumer.is_alive() and not early_output)
    early.close();early_consumer.join(2)
    check('early stream rescued by explicit close',not early_consumer.is_alive() and len(early_errors)==1)
    for name in ['eof','malformed','hold']:
        x=client(name);x.initialize(); outcome=[]
        def request():
            try:x.request('fixture/'+name,{},response_model=Reply);outcome.append('returned')
            except BaseException as e:outcome.append(type(e).__name__)
        worker=threading.Thread(target=request,daemon=True);worker.start()
        if name=='hold':
            worker.join(.15);check('request has no built-in short timeout',worker.is_alive())
            x.close()
        worker.join(2)
        check(name+' wakes waiter',not worker.is_alive() and len(outcome)==1 and outcome[0]!='returned')
    for name,module in tuple(sys.modules.items()):
        if name.startswith('openai_codex.') and name!='openai_codex.generated':
            origin=pathlib.Path(module.__file__).resolve()
            if not origin.is_relative_to(tree) or str(origin.relative_to(tree)) not in expected:raise ValueError('import origin')
finally:
    for c,proc in peers:
        c.close()
        if proc is not None:proc.wait(timeout=3)
check('all authored peers reaped',all(proc is None or proc.poll() is not None for _,proc in peers))
signal.alarm(0)
print(json.dumps({'checks':checks,'count':len(checks),'peers':len(peers),'scope':'Actual CodexClient/client dependency closure and generated types with synthetic stdio processes; no package facade, native Codex, provider, credentials, or CR application mapping'},indent=2))
