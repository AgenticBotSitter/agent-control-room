"""Original research fixture; executes unmodified pinned Hermes code, no server."""
import asyncio, hashlib, json, os, pathlib, sys, types, zipfile, time

root = pathlib.Path(sys.argv[1]).resolve()
if root.parent != pathlib.Path('/private/tmp') or not root.name.startswith('cr-f2-hermes-session.'):
    raise RuntimeError('unexpected owned root')
receipt = json.loads(pathlib.Path('docs/research/reuse-comparisons/f2-hermes-session-acquisitions.json').read_text())
digest = lambda b: hashlib.sha256(b).hexdigest()
verified = 0
for entry in receipt['sources']:
    assert digest((root / 'source' / entry['path']).read_bytes()) == entry['sha256']
for entry in receipt['wheels']:
    wheel = root / 'wheels' / entry['filename']
    assert digest(wheel.read_bytes()) == entry['sha256']
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.infolist():
            if member.is_dir() or member.filename.endswith('/RECORD'):
                continue
            assert '.data/' not in member.filename, 'unreviewed wheel relocation'
            target = root / 'target' / member.filename
            assert target.is_file() and not target.is_symlink()
            assert target.read_bytes() == archive.read(member.filename), member.filename
            verified += 1

# Exclude bundled runtime site-packages: complete isolated framework closure only.
sys.path[:] = [str(root / 'source'), str(root / 'target')] + [p for p in sys.path if 'site-packages' not in p and p]
def audit(event, args):
    if event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise RuntimeError('forbidden external effect: ' + event)
sys.addaudithook(audit)
from fastapi import HTTPException
from hermes_cli.web_routers import files
from starlette.responses import FileResponse

fixture = root / 'fixture'
for name in ['project-a', 'project-b', 'gateway']:
    (fixture / name).mkdir(parents=True, exist_ok=False)
a, b, gateway = [fixture / x for x in ['project-a', 'project-b', 'gateway']]
(a / 'report.txt').write_bytes(b'correct project A artifact')
(b / 'report.txt').write_bytes(b'other project B artifact')
(gateway / 'report.txt').write_bytes(b'wrong gateway artifact')
(a / '.env').write_bytes(b'synthetic prohibited fixture only')
os.chdir(gateway)
resolver_calls = []
async def get_session_detail(session_id, profile):
    resolver_calls.append([session_id, profile])
    selected = {('session-a', 'profile-a'): a, ('session-b', 'profile-b'): b}.get((session_id, profile))
    if selected is None:
        raise HTTPException(404, 'Session not found')
    return {'id': session_id, 'cwd': str(selected), 'profile': profile}
sessions = types.ModuleType('hermes_cli.web_routers.sessions')
sessions.get_session_detail = get_session_detail
sys.modules[sessions.__name__] = sessions

async def consume(response):
    assert type(response) is FileResponse
    messages = []
    async def send(message):
        messages.append(message)
        assert sum(len(m.get('body', b'')) for m in messages) < 4096
    async def receive():
        raise RuntimeError('unexpected receive')
    await asyncio.wait_for(response({'type': 'http', 'method': 'GET', 'headers': [], 'extensions': {}}, receive, send), 5)
    assert [m['type'] for m in messages] == ['http.response.start', 'http.response.body']
    body = b''.join(m.get('body', b'') for m in messages)
    return {'status': messages[0]['status'], 'body': body.decode(), 'sha256': digest(body),
            'headers': {k.decode(): v.decode() for k,v in messages[0]['headers']}}

async def main():
    rows = []
    async def check(name, path, profile='profile-a', sid='session-a', body=None, status=200):
        before = len(resolver_calls)
        try:
            response = await files.fs_download(path, profile, sid)
            result = await consume(response)
        except HTTPException as exc:
            result = {'status': exc.status_code, 'detail': exc.detail}
        assert result['status'] == status, (name, result)
        if body is not None:
            assert result['body'] == body, (name, result)
            assert result['headers']['content-disposition'].startswith('attachment;')
        rows.append({'name': name, 'actual': result, 'resolverCalls': len(resolver_calls)-before})
    await check('known-session-relative', './report.txt', body='correct project A artifact')
    await check('second-valid-session-same-name', './report.txt', 'profile-b', 'session-b', body='other project B artifact')
    await check('known-session-absolute', str(a/'report.txt'), body='correct project A artifact')
    await check('known-session-file-uri', (a/'report.txt').as_uri(), body='correct project A artifact')
    await check('wrong-profile-even-absolute', str(a/'report.txt'), 'profile-b', status=404)
    await check('unknown-session', './report.txt', sid='missing', status=404)
    await check('empty-session', './report.txt', sid='', status=404)
    await check('parent-reaches-other-project', '../project-b/report.txt', body='other project B artifact')
    await check('absolute-reaches-other-project', str(b/'report.txt'), body='other project B artifact')
    await check('sensitive-name-refused', '.env', status=403)
    response = await files.fs_download('report.txt', 'profile-a', 'session-a')
    (a/'report.txt').write_bytes(b'replacement after handler validation')
    changed = await consume(response)
    assert changed['body'] == 'replacement after handler validation'
    rows.append({'name': 'changed-after-handler-before-response-stream', 'actual': changed})
    (a/'report.txt').write_bytes(b'third version on next download')
    await check('changed-between-downloads', './report.txt', body='third version on next download')
    assert 'hermes_cli.web_server' not in sys.modules
    assert 'hermes_cli.config' not in sys.modules
    return {'cases': rows, 'caseCount': len(rows), 'verifiedInstalledFiles': verified,
        'sourcesUnmodified': True, 'scope': 'actual handler and FileResponse ASGI bytes; synthetic session resolver; no router/auth dispatch or CR admission',
        'substitutions': ['get_session_detail uses two synthetic session/profile tuples and owned cwd paths', 'local ASGI scope/send sink/receive guard instead of HTTP server'],
        'frameworkVersions': {name: __import__(name).__version__ for name in ['fastapi','starlette','pydantic']}}

started = time.monotonic()
result = asyncio.run(main())
result['elapsedSeconds'] = time.monotonic()-started
print(json.dumps(result, indent=2))
