"""Pure pinned planner subprocess; no SQLite, gateway or native invocation."""
import sys,json,pathlib,re,types,hashlib
root=pathlib.Path(sys.argv[1]);assert re.fullmatch(r'/private/tmp/control-room-f4planner\.[A-Za-z0-9]+',str(root))
expected=json.loads((pathlib.Path(__file__).resolve().parents[2]/'docs/research/reuse-comparisons/f4-planner-acquisitions.json').read_text())
checked=0
for item in expected:
    relative=item['url'].split('/fb3446a281e4bddc733a04bf92a5ec5f0d6decc9/',1)[1]
    if relative.endswith('.py'):
        assert hashlib.sha256((root/relative).read_bytes()).hexdigest()==item['sha256'], f'source hash mismatch: {relative}'
        checked+=1
assert checked==4,'four executable source identities required'
sys.path.insert(0,str(root))
from gateway import hosted_room_discussion as original
data=json.load(sys.stdin);module=original
if data['adapted']:
    source=(root/'gateway/hosted_room_discussion.py').read_text()
    begin=source.index('        responders = (\n',source.index('def plan_next_task('))
    end=source.index('        for member_index, member in enumerate(_rotate(responders, round_index)):',begin)
    source=source[:begin]+'        responders = room.members\n'+source[end:]
    source=source.replace('enumerate(_rotate(responders, round_index))','enumerate(responders)')
    module=types.ModuleType('gateway.research_adapted');sys.modules[module.__name__]=module
    exec(compile(source,'research_adapted','exec'),module.__dict__)
    module.MAX_DISCUSSION_ROUNDS=data['rounds'];module.MAX_DISCUSSION_MESSAGES=data['count']*data['rounds']
room=data['room'];events=data['events'];profiles=[m['profile'] for m in room['members']]
decision=module.plan_next_task(room,events,local_profiles=profiles)
result={'status':decision.status,'reason':decision.reason}
if decision.task:
    task=decision.task
    publication=module.plan_publication(room,events,task,status='settled',result={'text':data['opinion']},local_profiles=profiles)
    result.update({'participantId':task.member.member_id,'round':task.round_index+1,'taskId':task.identity.task_id,'promptLength':len(task.payload['prompt']), 'events':[{**e.append_kwargs(room['room_id']),'seq':len(events)+i+1}for i,e in enumerate(publication.events)]})
print(json.dumps(result))
