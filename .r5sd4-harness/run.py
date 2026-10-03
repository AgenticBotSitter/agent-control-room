import os, sys, subprocess, signal, json, time
from pathlib import Path
base=Path(__file__).resolve().parent
label,seconds,*command=sys.argv[1:]
record=base/(label+'-pids.jsonl')
env=os.environ.copy()
env['CONTROL_ROOM_TEST_BLOCK_AGENT_CLI']='1'
if (base/'preload.cjs').exists() and (base/'group-exec').exists():
    env['NODE_OPTIONS']='--require='+str(base/'preload.cjs')
    env['R5SD_RECORD']=str(record)
    env['R5SD_GROUP_EXEC']=str(base/'group-exec')
    env['CONTROL_ROOM_TEST_PID_RECORD']=str(record)
log=base/(label+'.log')
child=None
code=126
try:
    with log.open('wb') as output:
        child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=output,stderr=subprocess.STDOUT,env=env,preexec_fn=os.setpgrp)
        with record.open('a') as f:f.write(json.dumps({'pid':child.pid})+'\n')
        try:code=child.wait(timeout=int(seconds))
        except subprocess.TimeoutExpired:code=124
except OSError as error:
    code=126
    with log.open('a') as output:output.write('Tool spawn refused: errno '+str(error.errno)+'\n')
finally:
    ids=set()
    if record.exists():
        for line in record.read_text().splitlines():
            try:ids.add(json.loads(line)['pid'])
            except (ValueError,KeyError):pass
    for pid in ids:
        try:os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError:pass
        except PermissionError:print('CLEANUP BLOCKED',pid)
    if child:
        child.stdin.close()
        child.wait(timeout=10)
    time.sleep(.1)
    remaining=[]
    for pid in ids:
        for target in (pid,-pid):
            try:os.kill(target,0);remaining.append(target)
            except ProcessLookupError:pass
            except PermissionError:remaining.append(target)
    print('COMMAND',label,'EXIT',code,'RECORDED',len(ids),'REMAINING',remaining)
    content=log.read_text(errors='replace').replace(str(Path.cwd()),'<worktree>').replace(str(Path.home()),'<home>')
    log.write_text(content)
    print(content[-14000:])
sys.exit(code if not remaining else 125)
