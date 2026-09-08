"""Pinned real method bodies with synthetic request/router ports. No client startup."""
import ast
import hashlib
import json
import pathlib
import sys
import types
import uuid

root = pathlib.Path(sys.argv[1])
assert root.parent == pathlib.Path('/private/tmp') and root.name.startswith('cr-compare-f2.')
source = (root / 'python-client.py').read_bytes()
assert hashlib.sha256(source).hexdigest() == '76bdb1e63c62987c3530ea763e9655a06b308cbc4e18cb51958e85b6c23aec3b'
tree = ast.parse(source)
client = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'CodexClient')
selected = ['turn_interrupt', '_request_raw', 'notify']
methods = [n for n in client.body if isinstance(n, ast.FunctionDef) and n.name in selected]
assert len(methods) == len(selected)
module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)] + methods, type_ignores=[])
namespace = {'uuid': uuid, 'TurnInterruptResponse': object}
exec(compile(ast.fix_missing_locations(module), '<pinned-codex-methods>', 'exec'), namespace)
calls = []
target = types.SimpleNamespace(request=lambda *args, **kw: calls.append((args, kw)) or {'ack': True})
assert namespace['turn_interrupt'](target, 'thread-fixture', 'turn-fixture') == {'ack': True}
assert calls[0][0] == ('turn/interrupt', {'threadId': 'thread-fixture', 'turnId': 'turn-fixture'})
checks = ['actual interrupt method binds exact thread and turn IDs; no process cancellation tested']
pending = []
discarded = []
sent = []
router = types.SimpleNamespace(create_response_waiter=lambda key: pending.append(key) or types.SimpleNamespace(get=lambda: {'fixture': True}), discard_response_waiter=discarded.append)
def record_after_registration(message):
    assert message['id'] in pending, 'message written before waiter registration'
    sent.append(message)
target = types.SimpleNamespace(_router=router, _write_message=record_after_registration)
assert namespace['_request_raw'](target, 'thread/read', {'threadId': 'fixture'}) == {'fixture': True}
assert sent[0]['id'] == pending[0] and uuid.UUID(sent[0]['id'])
assert sent[0]['method'] == 'thread/read'
checks.append('actual request method registers ID before writing to synthetic peer')
def refuse(_message):
    raise RuntimeError('synthetic write failure')
target._write_message = refuse
try:
    namespace['_request_raw'](target, 'thread/read', {})
    raise AssertionError('write failure swallowed')
except RuntimeError:
    pass
assert discarded == [pending[-1]]
checks.append('actual write-failure path removes pending waiter')
target._write_message = sent.append
namespace['notify'](target, 'initialized')
assert sent[-1] == {'method': 'initialized'}
checks.append('actual initialized notification has no request ID')
print(json.dumps({'checks': checks, 'scope': 'three pinned method bodies; synthetic router, response model and peer; no Python SDK process, transport or full model import', 'nativeCalls': 0}, indent=2))
