"""Synthetic actual router subset; no client/process or provider construction."""
import hashlib, json, pathlib, queue, re, sys, types
root = pathlib.Path(sys.argv[1])
if not re.fullmatch(r'/private/tmp/control-room-f2router\.[A-Za-z0-9]+', str(root)):
    raise ValueError('owned root invalid')
receipt = pathlib.Path('docs/research/reuse-comparisons/f2-router-acquisitions.json')
expected = {'_message_router.py','_goal.py','models.py','errors.py','generated/notification_registry.py','generated/v2_all.py','client.py'}
rows = json.loads(receipt.read_text())
if len(rows) != 7 or {row['file'] for row in rows} != expected:
    raise ValueError('receipt source set invalid')
tree = root/'openai_codex'
if root.is_symlink() or tree.is_symlink() or root.resolve() != root:
    raise ValueError('source root symlink invalid')
entries = list(tree.rglob('*'))
if any(p.is_symlink() for p in entries):
    raise ValueError('source symlink invalid')
if {str(p.relative_to(tree)) for p in entries if p.is_file()} != expected:
    raise ValueError('exact source set invalid')
if {str(p.relative_to(tree)) for p in entries if p.is_dir()} != {'generated'}:
    raise ValueError('source directories invalid')
for row in rows:
    if hashlib.sha256((tree/row['file']).read_bytes()).hexdigest() != row['sha256']:
        raise ValueError('source hash invalid: '+row['file'])
if any(n == 'openai_codex' or n.startswith('openai_codex.') for n in sys.modules):
    raise ValueError('ambient candidate modules already loaded')
if '--verify-only' in sys.argv:
    print(json.dumps({'preflight':'passed','candidateImports':0}));sys.exit(0)
sys.dont_write_bytecode = True
# Explicit namespaces prevent an installed regular package elsewhere on sys.path
# from superseding the hash-checked namespace tree. No initializer is executed.
for name, path in [('openai_codex',tree),('openai_codex.generated',tree/'generated')]:
    package = types.ModuleType(name);package.__path__ = [str(path)]
    sys.modules[name] = package
from openai_codex._message_router import MessageRouter
from openai_codex.models import Notification, UnknownNotification
from openai_codex.generated.v2_all import AgentMessageDeltaNotification
import pydantic
origins = {}
for name, module in tuple(sys.modules.items()):
    if name.startswith('openai_codex.') and name != 'openai_codex.generated':
        origin = pathlib.Path(module.__file__).resolve()
        if not origin.is_relative_to(tree) or str(origin.relative_to(tree)) not in expected:
            raise ValueError('candidate import origin invalid: '+name)
        origins[name] = str(origin.relative_to(tree))
if set(origins.values()) != expected - {'client.py'}:
    raise ValueError('candidate imported module closure invalid')
checks=[]
def check(name, condition):
    assert condition, name
    checks.append(name)
def note(turn='turn-a', thread='thread-a'):
    return Notification('item/agentMessage/delta', AgentMessageDeltaNotification(delta='synthetic', itemId='item-a',threadId=thread,turnId=turn))
r=MessageRouter(); a=r.create_response_waiter('1'); b=r.create_response_waiter('2')
r.route_response({'id':2,'result':'b'});r.route_response({'id':1,'result':'a'})
check('out of order correlates', a.get_nowait()=='a' and b.get_nowait()=='b')
r.route_response({'id':1,'result':'duplicate'});r.route_response({'id':99,'result':'unknown'})
check('duplicate and unknown ignored', a.empty() and not r._response_waiters)
c=r.create_response_waiter('3');r.discard_response_waiter('3');r.route_response({'id':3,'result':'late'})
check('discarded late response ignored', c.empty())
old=r.create_response_waiter('4');new=r.create_response_waiter('4');r.route_response({'id':4,'result':'new'})
check('duplicate waiter registration overwrites old waiter', old.empty() and new.get_nowait()=='new')
r.route_notification(note());r.register_turn('turn-a')
check('typed early event replay', r.next_turn_notification('turn-a').payload.delta=='synthetic')
r.route_notification(note(thread='thread-b'))
check('same turn different thread not rejected by router',r.next_turn_notification('turn-a').payload.thread_id=='thread-b')
r.unregister_turn('turn-a');r.route_notification(note())
check('unregistered late event buffered',len(r._pending_turn_notifications['turn-a'])==1)
for i in range(1000):r.route_notification(note(turn=f'turn-{i}'))
check('1001 pending turn queues admitted without router cap',len(r._pending_turn_notifications)==1001)
for i in range(32):r.create_response_waiter(str(i))
check('32 response waiters admitted above CR16 cap',len(r._response_waiters)==32)
r.register_turn('live');waiter=r.create_response_waiter('disconnect');error=RuntimeError('synthetic disconnect');r.fail_all(error)
check('disconnect wakes response and clears pending',waiter.get_nowait() is error and not r._response_waiters and not r._pending_turn_notifications)
try:r.next_turn_notification('live')
except RuntimeError as exc:check('disconnect wakes active turn',exc is error)
else:raise AssertionError('turn did not fail')
after=r.create_response_waiter('after')
check('router accepts new waiter after fail_all without closed guard',after.empty() and 'after' in r._response_waiters)
u=MessageRouter();u.register_turn('unknown');u.route_notification(Notification('synthetic/event',UnknownNotification({'turnId':'unknown','threadId':'other'})))
check('unknown model routing actual dependency path',u.next_turn_notification('unknown').method=='synthetic/event')
print(json.dumps({'scope':'actual router plus actual dependency-complete generated model subset; no SDK package init or transport','python':sys.version.split()[0],'pydantic':pydantic.__version__,'hashesVerified':7,'verifiedModuleOrigins':origins,'checks':checks,'count':len(checks)},indent=2))
