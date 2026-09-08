"""Exercise pinned actual Hermes stdlib room modules; no agent or gateway startup."""
import sys, re, json, time, tempfile, pathlib, resource, hashlib
root = pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/control-room-f4\.[A-Za-z0-9]+', str(root))
sys.path.insert(0, str(root / 'hermes'))
from gateway import hosted_rooms as rooms
from gateway import hosted_room_driver as driver
from gateway import hosted_room_discussion as discussion
from gateway import hosted_room_peer as peer
from gateway import hosted_room_execution_policy as policy
from gateway.hosted_rooms_common import compact_json
began = time.monotonic()
checks = []
def check(name, ok):
    assert ok, name
    checks.append(name)
def raises(kind, fn):
    try: fn()
    except kind: return True
    return False
with tempfile.TemporaryDirectory(prefix='hermes-state-',dir=root) as owned:
    db=pathlib.Path(owned)/'state.db'
    members=[{'member_id':'member-one','profile':'one','handle':'one'}, {'member_id':'member-two','profile':'two','handle':'two'}]
    room=rooms.create_room(db,room_id='room-1',name='Synthetic discussion',members=members,authority_gateway_id='gateway-a',now=90)
    clock=[100.0]
    now=lambda: clock[0]
    identity=driver.TaskIdentity(room_id='room-1',task_id='task-1',thread_id='thread-1',turn_id='turn-1')
    payload={'target_profile':'one','prompt':'Synthetic bounded opinion','source_event_seq':1}
    driver.admit_task(db,identity,payload=payload,clock=now)
    check('duplicate admission idempotent',driver.admit_task(db,identity,payload=payload,clock=now)['idempotent'])
    check('changed payload rejected',raises(driver.TaskConflictError,lambda:driver.admit_task(db,identity,payload={**payload,'prompt':'changed'},clock=now)))
    lease=driver.acquire_lease(db,room_id='room-1',gateway_id='gateway-a',authority_epoch=1,process_generation='process-a',ttl_seconds=5,clock=now)
    driver.start_task(db,identity,lease,expected_cancel_generation=0,clock=now)
    check('live lease blocks second process',raises(driver.LeaseHeldError,lambda:driver.acquire_lease(db,room_id='room-1',gateway_id='gateway-a',authority_epoch=1,process_generation='process-b',ttl_seconds=5,clock=now)))
    clock[0]+=5
    new=driver.acquire_lease(db,room_id='room-1',gateway_id='gateway-a',authority_epoch=1,process_generation='process-b',ttl_seconds=30,clock=now)
    recovery=driver.recover_room(db,new,clock=now)
    check('expired running task indeterminate',recovery['indeterminate']==[identity])
    check('uncertain start never auto requeued',driver.get_task(db,identity)['status']=='indeterminate')
    # Separate real room event log: deterministic plan, deferred participant, bounded turns.
    rooms.append_event(db,room_id='room-1',event_id='user-1',kind='message.user',actor={'kind':'user','id':'user'},authority_gateway_id='gateway-a',authority_epoch=1,payload={'text':'Discuss this synthetic idea.','thread_id':'discussion-1'},now=101)
    def events():return rooms.read_events(db,room_id='room-1',since_seq=0,limit=rooms.MAX_LOG_LIMIT)['events']
    def plan():return discussion.plan_next_task(room,events(),local_profiles=('one','two'))
    first=plan().task
    check('stable task identity from same event log',first.identity==plan().task.identity)
    publication=discussion.plan_publication(room,events(),first,status='deferred',result={'reason':'member_unavailable'},execution_generation=1,local_profiles=('one','two'))
    for e in publication.events:rooms.append_event(db,**e.append_kwargs('room-1'),now=102)
    check('unavailable participant does not block another',plan().task.member.member_id!=first.member.member_id)
    turns=0
    for i in range(12):
        decision=plan()
        if decision.status!='task':break
        publication=discussion.plan_publication(room,events(),decision.task,status='settled',result={'text':'Synthetic contribution'},local_profiles=('one','two'))
        for e in publication.events:rooms.append_event(db,**e.append_kwargs('room-1'),now=103+i)
        turns+=1
    check('discussion eventually bounded or settled',plan().status in ('bounded','settled','idle'))
    check('within ten discussion messages',turns<=10)
    unsigned={'version':1,'target_profile':'one','enabled_toolsets':[],'approval_mode':'manual','max_iterations':1}
    zero={**unsigned,'policy_digest':hashlib.sha256(compact_json(unsigned).encode('ascii')).hexdigest()}
    check('zero tool room policy refused',raises(policy.RoomExecutionPolicyError,lambda:policy.RoomExecutionPolicy.from_mapping(zero)))
    secret=b'synthetic-disposable-secret-only!'
    token=peer.issue_room_grant(secret,grant_id='grant-1',room_id='room-1',home_install_id='home',authority_gateway_id='gateway-a',authority_epoch=1,member_id='member-one',target_install_id='target',target_profile='one',execution_policy_digest='a'*64,permissions=('status',),issued_at=100,ttl_seconds=30)
    check('scoped status grant validates',peer.decode_room_grant(secret,token,permission='status',now=101)['room_id']=='room-1')
    check('status grant cannot dispatch',raises(peer.HostedRoomGrantError,lambda:peer.decode_room_grant(secret,token,permission='dispatch',now=101)))
    check('expired grant refused',raises(peer.HostedRoomGrantError,lambda:peer.decode_room_grant(secret,token,permission='status',now=131)))
print(json.dumps({'checks':checks,'providerCalls':0,'actualModules':True,'temporaryStateCleaned':True,'elapsedMs':(time.monotonic()-began)*1000,'maxRSSNativeUnits':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},indent=2))
