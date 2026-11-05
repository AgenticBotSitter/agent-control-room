#!/usr/bin/env python3
"""One-shot, offline B5 carrier preparation. Never enables jobs or starts intake.

Run with the configured Python and independently approved source/runtime pins.
A failed invocation consumes its fresh root; it is never resumed or removed here.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT_NAME = re.compile(r'acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}')
REVISION = re.compile(r'[a-f0-9]{40}')
HEX = re.compile(r'[a-f0-9]{64}')
CREDENTIAL = re.compile(r'(?:\.env(?:\..*)?|\.codex|\.hermes|\.aws|\.ssh|auth\.json|tokens?|credentials?|passwords?)', re.I)
ROOTS = dict(CR_LEAD_ROOT='lead', CR_RUNS='runs', CR_WORK_ROOT='work', CR_LOG_ROOT='logs',
             CR_HOME_WORK='home-work', CR_SCRATCH_PARENT='tmp', CR_MODELS='tools/loop/models.tsv',
             CR_SKILLS='lead/skills-src', CR_TEMPLATES='tools/loop/templates',
             CR_JOB_ENV='lead/job-env.json', CR_CONFIG_ROOT='config')


def require(value, code):
    if not value:
        raise ValueError(code)


def path_check(value, directory=False, exists=True):
    p = Path(value)
    require(p.is_absolute() and os.path.normpath(str(p)) == str(p), 'B5_PATH')
    require(not any(CREDENTIAL.fullmatch(x) for x in p.parts), 'B5_CREDENTIAL_PATH')
    require(all(not x.is_symlink() for x in (p, *p.parents)), 'B5_SYMLINK')
    if exists:
        require(p.is_dir() if directory else p.is_file(), 'B5_PATH_TYPE')
        require(p.resolve() == p, 'B5_CANONICAL_PATH')
    return p


def command(argv, cwd=None, env=None):
    # Never expose subprocess payloads (which can contain input text or identity).
    result = subprocess.run(list(map(str, argv)), cwd=cwd, env=env, capture_output=True, timeout=120)
    require(result.returncode == 0, 'B5_COMMAND_FAILED')
    return result.stdout


def git(root, *args):
    return command(['/usr/bin/git', '-C', root, *args])


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('xb') as stream:
        stream.write(data.encode() if isinstance(data, str) else data)
    path.chmod(0o600)


def json_new(path, value):
    write_new(path, json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n')


def digest(path):
    return hashlib.sha256(path_check(path).read_bytes()).hexdigest()


def source_check(source, pin):
    source = path_check(source, directory=True)
    require(bool(REVISION.fullmatch(pin)), 'B5_SOURCE_PIN')
    require(git(source, 'rev-parse', 'HEAD').decode().strip() == pin, 'B5_SOURCE_PIN')
    require(not git(source, 'status', '--porcelain', '--untracked-files=all'), 'B5_SOURCE_DIRTY')
    return source


def exclusive_root(root):
    require(not os.path.lexists(root), 'B5_ROOT_EXISTS')
    path_check(root, exists=False)
    old_mask = os.umask(0o077)
    try:
        try:
            os.mkdir(root, 0o700)
        except FileExistsError:
            raise ValueError('B5_ROOT_EXISTS') from None
    finally:
        os.umask(old_mask)


class Custody:
    """Exclusive root creation and retained parent/root filesystem identities."""
    def __init__(self, parent, root, forbidden=()):
        self.parent, self.root = Path(parent), Path(root)
        require(ROOT_NAME.fullmatch(self.root.name), 'B5_ROOT_NAME')
        require(self.root.parent == self.parent, 'B5_DIRECT_CHILD')
        path_check(self.parent, directory=True)
        require(self.parent.stat().st_uid == os.getuid() and not self.parent.stat().st_mode & 0o022,
                'B5_PARENT_CUSTODY')
        for ancestor in (self.parent, *self.parent.parents):
            require(not os.path.lexists(ancestor / '.git'), 'B5_PARENT_GIT')
            require(ancestor.name != 'i1-R', 'B5_FORBIDDEN_ROOT')
        # Reject Git worktrees with a gitdir outside their directory too.
        probe = subprocess.run(['/usr/bin/git', '-C', str(self.parent), 'rev-parse', '--show-toplevel'],
                               capture_output=True, timeout=20)
        require(probe.returncode != 0, 'B5_PARENT_GIT')
        for source in forbidden:
            source = Path(source).resolve()
            require(self.parent != source and source not in self.parent.parents, 'B5_FORBIDDEN_ROOT')
        # A live install layout is never an approved staging parent.
        for ancestor in (self.parent, *self.parent.parents):
            require(not (ancestor / 'config/installation.json').exists()
                    and not (ancestor / 'current').exists(), 'B5_FORBIDDEN_ROOT')
        self.parent_identity = self.identity(self.parent)
        exclusive_root(self.root)
        self.root_identity = self.identity(self.root)
        self.check()

    @staticmethod
    def identity(path):
        info = path.lstat()
        return info.st_dev, info.st_ino, info.st_uid

    def check(self):
        for path, identity in ((self.parent, self.parent_identity), (self.root, self.root_identity)):
            path_check(path, directory=True)
            require(self.identity(path) == identity and path.stat().st_uid == os.getuid(), 'B5_CUSTODY_CHANGED')
        require(not self.parent.stat().st_mode & 0o022, 'B5_PARENT_CUSTODY')
        require(stat.S_IMODE(self.root.stat().st_mode) == 0o700
                and not os.path.lexists(self.root / '.git'), 'B5_ROOT_CUSTODY')


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def interpreter_bytes_check(safety, canonical, approved):
    require(HEX.fullmatch(approved) and safety.sha(canonical) == approved, 'B5_INTERPRETER_BYTES')


def interpreter_check(stage, safety, root, supplied, approved):
    lexical = path_check(supplied, exists=False)
    canonical = safety.safe_path(lexical.resolve())
    require(os.access(canonical, os.X_OK), 'B5_INTERPRETER_EXECUTABLE')
    require(stage.configured_python(root / 'tools') == canonical, 'B5_INTERPRETER_IDENTITY')
    interpreter_bytes_check(safety, canonical, approved)
    require(os.path.samefile(sys.executable, canonical), 'B5_INVOKING_INTERPRETER')
    return canonical


def roster_check(safety, root, expected, inputs=None):
    paths = [root / 'tools/loop/models.tsv']
    if inputs is not None:
        paths.append(inputs / 'models.tsv')
    else:
        paths.append(root / 'config/models.tsv')
    require(all(safety.safe_path(p).read_bytes() == expected for p in paths), 'B5_ROSTER_BYTES')


def recipe_check(checks, root, recipes, node_sha256=None):
    """Use the staged handoff pin, or the producer's approved pin before freeze."""
    require(isinstance(checks, list) and len(checks) == len(recipes), 'B5_RECIPE_MISMATCH')
    require(all(isinstance(c, dict) and isinstance(c.get('argv'), list) and c['argv']
                for c in checks), 'B5_RECIPE_MISMATCH')
    expected = json.loads(json.dumps(recipes))
    if any(c['argv'][0] != 'node' for c in checks):
        try:
            if node_sha256 is None:
                handoff = path_check(root / 'config/b5-handoff.json')
                require(handoff.stat().st_uid == os.getuid() and not handoff.stat().st_mode & 0o022,
                        'B5_RECIPE_MISMATCH')
                node_sha256 = json.loads(handoff.read_text())['nodeSha256']
            require(isinstance(node_sha256, str) and HEX.fullmatch(node_sha256), 'B5_RECIPE_MISMATCH')
            node = path_check(root / 'runtime/bin/node')
            stat_node = node.stat()
            require(stat_node.st_uid == os.getuid() and not stat_node.st_mode & 0o022
                    and stat_node.st_mode & 0o111 and stat_node.st_size <= (256 << 20)
                    and digest(node) == node_sha256, 'B5_RECIPE_MISMATCH')
        except (ValueError, OSError, KeyError, TypeError):
            raise ValueError('B5_RECIPE_MISMATCH') from None
        for check, recipe in zip(checks, expected):
            if check['argv'][0] != 'node':
                recipe['argv'][0] = str(node)
    require(json.dumps(checks, sort_keys=True) == json.dumps(expected, sort_keys=True), 'B5_RECIPE_MISMATCH')


def reviewed_settings(settings, availability, root, baseline, python, dry, cr, run_settings, constants, node_sha256=None):
    dry.settings_paths(settings, root, str(python))
    roster = root / 'tools/loop/models.tsv'
    require(not cr.models_problems(roster, allow_standard_final=True), 'B5_ROSTER_INVALID')
    rows = cr.models()
    effective, provenance = run_settings.prepare(
        settings, roster=rows, repository_root=root / 'work/repo', output_root=root / 'work/repo',
        skills_root=root / 'lead/skills-src',
        project_recipe=dict(project=dict(repository=str(root / 'work/repo'), base=baseline)))
    project = effective['project']
    require(project['repository'] == str(root / 'work/repo') and project['base'] == baseline, 'B5_REPOSITORY_BASE')
    recipe_check(project['test_checks'], root, constants['recipes'], node_sha256)
    require(set(project['risk_categories']) == set(constants['risk']['categories']), 'B5_RISK_CATEGORIES')
    require(sorted(s['role'] for s in effective['roles']['risk_reviews']) == sorted(constants['risk']['slots']), 'B5_RISK_SLOTS')
    require(effective['code_review_count'] == 2 and len(effective['roles']['code_reviews']) == 2, 'B5_CODE_REVIEW_SLOTS')
    cr.chain_settings_setup(effective)
    result = cr.saved_lineup(dict(run_settings.engine_settings(effective), overrides=effective['overrides']),
                             effective, rows, availability)
    require(result.get('eligible') is True and not any(not r.get('waived', False) for r in result['reasons']), 'B5_LINEUP')
    return dict(effective=effective, provenance=provenance, lineup=result)


def private_tree(root):
    for folder, directories, files in os.walk(root, followlinks=False):
        path_check(folder, directory=True).chmod(0o700)
        for name in directories:
            file = Path(folder) / name
            require(not file.is_symlink() or any(d in file.parents and d in file.resolve().parents
                    for d in (root / 'product/node_modules', root / 'runtime/pnpm')), 'B5_TREE_LINK')
        for name in files:
            file = Path(folder) / name
            if file.is_symlink():
                # Cached dependency links are allowed only inside that dependency tree.
                dependencies = (root / 'product/node_modules', root / 'runtime/pnpm')
                require(any(d in file.parents and d in file.resolve().parents for d in dependencies), 'B5_TREE_LINK')
                continue
            path_check(file).chmod(0o700 if file.stat().st_mode & 0o111 else 0o600)


def copy_dependencies(source, target):
    path_check(source, directory=True)
    shutil.copytree(source, target, symlinks=True)
    for folder, directories, files in os.walk(target, followlinks=False):
        for name in directories + files:
            p = Path(folder) / name
            require(not p.is_symlink() or target in p.resolve().parents, 'B5_DEPENDENCY_ESCAPE')


def verify_export(source, pin, target, prefixes):
    names = git(source, 'ls-tree', '-r', '--name-only', pin, '--', *prefixes).decode().splitlines()
    for name in names:
        require(path_check(target / name).read_bytes() == git(source, 'show', pin + ':' + name), 'B5_EXPORT_BYTES')


def stage_tools(tools, tools_pin, root):
    # Bootstrap only these two verified tracked modules; all producer imports are in R.
    for name in ('stage.py', 'safety.py'):
        rel = 'loop/bridge/i1/' + name
        write_new(root / 'tools' / rel, git(tools, 'show', tools_pin + ':' + rel))
    sys.path.insert(0, str(root / 'tools/loop/bridge/i1'))
    safety = load_module('safety', root / 'tools/loop/bridge/i1/safety.py')
    sys.modules['safety'] = safety
    stage = load_module('b5_stage', root / 'tools/loop/bridge/i1/stage.py')
    source_check(tools, tools_pin)
    stage.extract(tools, root / 'tools', ['bin', 'loop', 'skills-src'])
    verify_export(tools, tools_pin, root / 'tools', ['bin', 'loop', 'skills-src'])
    source_check(tools, tools_pin)
    return stage, safety


def produce(args):
    require(args.root and ROOT_NAME.fullmatch(Path(args.root).name), 'B5_ROOT_NAME')
    require(all(getattr(args, key) for key in ('scratch_parent', 'product', 'product_pin', 'tools', 'tools_pin',
            'inputs', 'python', 'python_sha256', 'node', 'node_sha256')), 'B5_INPUTS_REQUIRED')
    tools = source_check(args.tools, args.tools_pin)
    product = source_check(args.product, args.product_pin)
    inputs = path_check(args.inputs, directory=True)
    node = path_check(args.node)
    require(HEX.fullmatch(args.node_sha256) and digest(node) == args.node_sha256, 'B5_NODE_BYTES')
    require(command([node, '--version']).startswith(b'v22.'), 'B5_NODE_VERSION')
    # Never synthesize a baseline Git identity or override the caller's Git environment.
    git(product, 'var', 'GIT_AUTHOR_IDENT')
    git(product, 'var', 'GIT_COMMITTER_IDENT')
    custody = Custody(args.scratch_parent, args.root, (tools, product))
    root = custody.root
    os.umask(0o077)
    for folder in ('tools/loop/bridge/i1', 'product', 'lead/bin', 'lead/skills-src', 'lead/state', 'lead/reports',
                   'lead/briefs', 'runs', 'work/repo', 'logs', 'home-work', 'tmp', 'runtime/bin', 'config/i1'):
        (root / folder).mkdir(parents=True, exist_ok=True, mode=0o700)
    stage, safety = stage_tools(tools, args.tools_pin, root)
    safety.safe_path(custody.parent, kind='dir')
    safety.safe_path(root, exists=False)
    # --no-hardlinks gives this packet independent Git objects and retained ancestry, no remote.
    command(['/usr/bin/git', 'clone', '--quiet', '--no-hardlinks', '--no-checkout', product, root / 'product'])
    git(root / 'product', 'checkout', '--quiet', '--detach', args.product_pin)
    git(root / 'product', 'remote', 'remove', 'origin')
    source_check(product, args.product_pin)
    verify_export(product, args.product_pin, root / 'product', [])
    copy_dependencies(product / 'node_modules', root / 'product/node_modules')
    shutil.copytree(root / 'tools/bin', root / 'lead/bin', dirs_exist_ok=True)
    shutil.copytree(root / 'tools/skills-src', root / 'lead/skills-src', dirs_exist_ok=True)
    shutil.copyfile(root / 'tools/loop/bridge/i1/launch-router.py', root / 'lead/bin/launch-router.py')
    shutil.copyfile(node, root / 'runtime/bin/node')
    (root / 'runtime/bin/node').chmod(0o700)
    if args.pnpm_package:
        pnpm = stage.pnpm_package(args.pnpm_package)
        copy_dependencies(pnpm, root / 'runtime/pnpm')
    environment = dict(PATH=str(root / 'runtime/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME=str(root / 'home-work'),
                       TMPDIR=str(root / 'tmp'), TZ='UTC', LANG='C', LC_ALL='C', LOOP_LEAN='1',
                       PROCESS_SKILLS_ROOT=str(root / 'lead/skills-src'))
    json_new(root / 'lead/job-env.json', environment)
    roots = {key: str(root / value) for key, value in ROOTS.items()}
    json_new(root / 'tools/loop/bridge/cr-entry.json', roots)
    os.environ.update(roots)
    os.environ.update(environment)
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    python = interpreter_check(stage, safety, root, args.python, args.python_sha256)
    # Read the pinned product exports through their actual TypeScript module, without a seed helper call.
    require(digest(root / 'runtime/bin/node') == args.node_sha256, 'B5_NODE_BYTES')
    exports = command([root / 'runtime/bin/node', '--import', 'tsx', '--input-type=module', '-e',
        "import {B5_BASELINE_INDEX as index,B5_PROTECTED_TESTS as tests,B5_RECIPES as recipes,B5_REQUIRED_RISK as risk} from './tests/helpers/improve-control-room-first-website.ts'; console.log(JSON.stringify({index,tests,recipes,risk}));"], root / 'product', environment)
    constants = json.loads(exports)
    repo = root / 'work/repo'
    # Baseline commits must use the original invoking Git environment, not the R assembly HOME.
    git_env = args.git_environment
    command(['/usr/bin/git', '-C', repo, 'init', '--quiet', '--initial-branch=cook/b5-proof'], env=git_env)
    write_new(repo / 'index.html', constants['index'])
    for name, data in constants['tests'].items():
        write_new(repo / name, data)
    command(['/usr/bin/git', '-C', repo, 'add', '.'], env=git_env)
    command(['/usr/bin/git', '-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
             'commit', '--quiet', '-m', 'B5 website baseline'], env=git_env)
    baseline = git(repo, 'rev-parse', 'HEAD').decode().strip()
    expected_roster = git(tools, 'show', args.tools_pin + ':loop/models.tsv')
    roster_check(safety, root, expected_roster, inputs)
    settings = safety.read_json(inputs / 'settings.json')
    availability = safety.read_json(inputs / 'availability.json')
    settings.setdefault('project', {}).update(repository=str(repo), base=baseline)
    require(settings['project'].get('host_adapter') == 'local-loop', 'B5_HOST_ADAPTER_REQUIRED')
    # Supplied evidence is independent data. Its scope is preserved, never upgraded to certification.
    for name in ('b5-qualification.json', 'authorization.json', 'fault-input.txt', 'review-input.txt'):
        source_input = safety.safe_path(inputs / name)
        require(source_input.stat().st_uid == os.getuid() and not source_input.stat().st_mode & 0o022, 'B5_INPUT_CUSTODY')
        data = source_input.read_bytes()
        require(0 < len(data) <= 65536, 'B5_INPUT_SIZE')
        write_new(root / 'config' / name, data)
    authorization = safety.read_json(root / 'config/authorization.json', root)
    require(isinstance(authorization, dict) and bool(authorization), 'B5_AUTHORIZATION_PACKET')
    qualification = safety.read_json(root / 'config/b5-qualification.json', root)
    require(qualification.get('scope') in ('assembly-only', 'provider-device'), 'B5_QUALIFICATION_SCOPE')
    require((root / 'config/fault-input.txt').read_bytes() != (root / 'config/review-input.txt').read_bytes(), 'B5_DISTINCT_STIMULI')
    for name in ('fault-input.txt', 'review-input.txt'):
        (root / 'config' / name).chmod(0o400)
    sys.path.insert(0, str(root / 'tools/loop'))
    dry = load_module('b5_dry', root / 'tools/loop/i1-dry-run.py')
    cr = load_module('b5_cr', root / 'tools/loop/cr.py')
    run_settings = load_module('run_settings', root / 'tools/loop/run_settings.py')
    reviewed_settings(settings, availability, root, baseline, python, dry, cr, run_settings, constants, args.node_sha256)
    custody.check()
    interpreter_check(stage, safety, root, args.python, args.python_sha256)
    stage.stage_configuration(root, inputs, settings)
    roster_check(safety, root, expected_roster)
    write_new(root / 'config/source-revision.txt', args.tools_pin + '\n')
    custody.check()
    interpreter_check(stage, safety, root, args.python, args.python_sha256)
    stage.repin(root, python)
    # Producer rewrites are covered by the exact same validators, before any freeze.
    validated = reviewed_settings(safety.read_json(root / 'config/settings.json', root),
        safety.read_json(root / 'config/availability.json', root), root, baseline, python, dry, cr, run_settings, constants, args.node_sha256)
    roster_check(safety, root, expected_roster)
    interpreter_check(stage, safety, root, args.python, args.python_sha256)
    private_tree(root)
    for name in ('fault-input.txt', 'review-input.txt'):
        (root / 'config' / name).chmod(0o400)
    carrier = safety.read_json(root / 'config/contract-cleanup.json', root)
    c = carrier['configuration']
    require(c['interpreter'] == str(python) and c['interpreterSha256'] == args.python_sha256, 'B5_CARRIER_INTERPRETER')
    for key, hash_key in (('settingsFile', 'settingsSha256'), ('availabilityFile', 'availabilitySha256'), ('entrypoint', 'entrypointSha256')):
        require(safety.sha(safety.safe_path(c[key], root)) == c[hash_key], 'B5_CARRIER_PIN')
    require(safety.sha(root / 'config/manifest.sha256') == c['toolingRevision'].removeprefix('sha256:'), 'B5_MANIFEST_PIN')
    require(safety.sha(root / 'tools/loop/bridge/a2-contract.mjs') == carrier['moduleSha256'], 'B5_MODULE_PIN')
    # Real loader, product schemas, adapter and bind-input --help only. No I-1 setup/harness.
    interpreter_check(stage, safety, root, args.python, args.python_sha256)
    require(digest(root / 'runtime/bin/node') == args.node_sha256, 'B5_NODE_BYTES')
    command([root / 'runtime/bin/node', '--import', 'tsx', 'tests/helpers/improve-control-room-first-website-a2.ts',
             '--qualify', root, args.python_sha256], root / 'product', environment)
    custody.check()
    require(not (root / 'config/b5.json').exists() and not (root / 'config/i1/real-jobs-enabled').exists()
            and not (root / 'evidence').exists(), 'B5_LATER_SLICE_OUTPUT')
    hashes = {str(p.relative_to(root)): safety.sha(p) for p in (root / 'config').rglob('*') if p.is_file()}
    json_new(root / 'config/b5-handoff.json', dict(schemaVersion=1, scope=qualification['scope'],
        productPin=args.product_pin, toolsPin=args.tools_pin, baseline=baseline, hashes=hashes,
        pythonSha256=args.python_sha256, nodeSha256=args.node_sha256,
        validation=validated, nativeIntakeQualified=False, providerDeviceCertified=False))
    custody.check()
    print('RESULT: PASS B5 frozen preparation packet (assembly only; no B5 readiness claim)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('root', 'scratch-parent', 'product', 'product-pin', 'tools', 'tools-pin', 'inputs',
                   'python', 'python-sha256', 'node', 'node-sha256', 'pnpm-package'):
        parser.add_argument('--' + option)
    args = parser.parse_args()
    args.git_environment = dict(os.environ)
    try:
        produce(args)
    except (ValueError, OSError, KeyError, TypeError, AssertionError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'B5_PREPARATION_REFUSED'
        print(code, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
