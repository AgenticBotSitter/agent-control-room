"""Selected actual synchronous SDK closure, synthetic finite stdio peer only."""
import json,sys,pathlib
if len(sys.argv)>1 and sys.argv[1]=='--peer':
 mode=sys.argv[2];thread='thread-fixture';turn='turn-fixture'
 def emit(x):print(json.dumps(x),flush=True)
 for line in sys.stdin:
  if len(line)>16000:raise ValueError('fixture input bound')
  m=json.loads(line);method=m.get('method')
  if method=='initialize':emit({'id':m['id'],'result':{'userAgent':'synthetic'}})
  elif method=='thread/resume':
   assert m['params']['threadId']==thread
   emit({'id':m['id'],'result':{'approvalPolicy':'never','approvalsReviewer':'user','cwd':'/synthetic','model':'synthetic','modelProvider':'synthetic','sandbox':{'type':'readOnly'},'thread':{'id':'wrong-resume' if mode=='wrong-resume' else thread,'sessionId':'session-fixture','cliVersion':'synthetic','createdAt':0,'updatedAt':0,'cwd':'/synthetic','ephemeral':True,'modelProvider':'synthetic','preview':'','source':'appServer','status':{'type':'idle'},'turns':[]}}})
  elif method=='turn/start':
   assert m['params']['threadId']==thread
   emit({'id':m['id'],'result':{'turn':{'id':turn,'items':[],'status':'inProgress'}}})
  elif method=='fixture/emit':
   tid='different-thread' if mode=='wrong-thread' else thread;rid='different-turn' if mode=='wrong-turn' else turn
   emit({'method':'turn/started','params':{'threadId':tid,'turn':{'id':rid,'items':[],'status':'inProgress'}}})
   usage={'inputTokens':17,'cachedInputTokens':5,'outputTokens':8,'reasoningOutputTokens':3,'totalTokens':25}
   def usage_event():emit({'method':'thread/tokenUsage/updated','params':{'threadId':tid,'turnId':rid,'tokenUsage':{'last':usage,'total':usage}}})
   usage_event()
   if mode!='disconnect':emit({'method':'turn/completed','params':{'threadId':tid,'turn':{'id':rid,'items':[],'status':'completed'}}})
   if mode=='late-usage':usage_event()
   break
 sys.exit(0)

import hashlib,types,signal,os
def timeout(*args):raise TimeoutError('12-second experiment deadline')
signal.signal(signal.SIGALRM,timeout);signal.alarm(12)
root=pathlib.Path(sys.argv[1]);tree=root/'openai_codex';assert root.resolve()==root and not root.is_symlink();receipt=json.loads(pathlib.Path('docs/research/reuse-comparisons/f2-client-acquisitions.json').read_text());expected={r['file']for r in receipt['files']};assert {str(p.relative_to(tree))for p in tree.rglob('*')if p.is_file()}==expected
for row in receipt['files']:assert hashlib.sha256((tree/row['file']).read_bytes()).hexdigest()==row['sha256']
sys.dont_write_bytecode=True
for name,p in [('openai_codex',tree),('openai_codex.generated',tree/'generated')]:
 assert name not in sys.modules;m=types.ModuleType(name);m.__path__=[str(p)];sys.modules[name]=m
from openai_codex.client import CodexClient,CodexConfig
from openai_codex.models import UnknownNotification
import pydantic
results=[];peers=[]
try:
 for mode in ['valid','wrong-resume','wrong-thread','wrong-turn','late-usage','disconnect','settlement-uncertain']:
  c=CodexClient(CodexConfig(launch_args_override=(sys.executable,str(pathlib.Path(__file__).resolve()),'--peer',mode),cwd=str(root)),approval_handler=lambda *_:{'decision':'decline'});c.start();proc=c._proc;peers.append((c,proc));c.initialize();resumed=c.thread_resume('thread-fixture');result={'mode':mode,'requestedThreadId':'thread-fixture','returnedThreadId':resumed.thread.id,'turnId':None,'notifications':[],'turnStartInvoked':False}
  if resumed.thread.id=='thread-fixture':
   started=c.turn_start('thread-fixture','Synthetic observer only');result['turnId']=started.turn.id;result['turnStartInvoked']=True;c.notify('fixture/emit',{})
   while True:
    try:n=c.next_turn_notification(started.turn.id)
    except Exception as e:result['streamEndError']=type(e).__name__;break
    assert not isinstance(n.payload,UnknownNotification),'expected actual generated notification model'
    result['notifications'].append({'method':n.method,'params':n.payload.model_dump(mode='json',by_alias=True,exclude_none=True),'model':type(n.payload).__name__})
  c.close();proc.wait(timeout=3);result['peerReaped']=proc.poll()is not None;results.append(result)
 for name,m in tuple(sys.modules.items()):
  if name.startswith('openai_codex.')and name!='openai_codex.generated':assert str(pathlib.Path(m.__file__).resolve().relative_to(tree))in expected
finally:
 for c,p in peers:c.close();p.wait(timeout=3)
signal.alarm(0)
print(json.dumps({'scope':'Actual selected synchronous client plus generated models, public explicit resume/turn/notification methods; controlled emission after registration; source package facade excluded. No native/provider.', 'python':sys.version.split()[0],'pydantic':pydantic.__version__,'allPeersReaped':all(p.poll()is not None for _,p in peers),'results':results},indent=2))
