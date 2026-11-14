"""Independent tasks-tree isolation diagnostic, excluded from bin discovery."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

KIT = Path(__file__).resolve().parents[2]


def tree_digest(base):
    result = hashlib.sha256()
    for path in sorted(base.rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            result.update(path.relative_to(base).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return result.hexdigest()


class LeanIsolationTests(unittest.TestCase):
    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(KIT / 'bin/build_prompts.py'), *map(str, args)],
                              cwd=KIT, capture_output=True, timeout=30)

    def test_explicit_output_preserves_all_tasks(self):
        before = tree_digest(KIT / 'tasks')
        with tempfile.TemporaryDirectory(dir=KIT.parent) as temporary:
            result = self.cli('--lean', '--out', Path(temporary) / 'variants', 'codereview-m1')
        self.assertEqual(tree_digest(KIT / 'tasks'), before, 'lean output changed tasks/')
        self.assertEqual(result.returncode, 0, 'explicit lean output must succeed')
        refused = self.cli('--lean', '--out', KIT / 'tasks/forbidden-lean', 'codereview-m1')
        self.assertEqual(refused.returncode, 2, 'output under tasks/ must refuse')
        self.assertEqual(tree_digest(KIT / 'tasks'), before)

    def test_missing_output_refused(self):
        before = tree_digest(KIT / 'tasks')
        result = self.cli('--lean', 'codereview-m1')
        self.assertEqual(tree_digest(KIT / 'tasks'), before)
        self.assertEqual(result.returncode, 2, 'lean without --out must refuse')


if __name__ == '__main__':
    unittest.main()
