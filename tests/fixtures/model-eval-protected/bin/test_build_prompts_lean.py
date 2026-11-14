"""Independent maintenance acceptance tests; never invoke model runners."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

KIT = Path(__file__).resolve().parents[1]


class LeanPromptTests(unittest.TestCase):
    def test_full_suite_lean_variant(self):
        with tempfile.TemporaryDirectory(dir=KIT.parent) as temporary:
            output = Path(temporary) / 'variants'
            result = subprocess.run([sys.executable, '-B', str(KIT / 'bin/build_prompts.py'),
                                     '--lean', '--out', str(output), 'codereview-m1'],
                                    cwd=KIT, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, 'explicit lean generation must succeed')
            prompt = (output / 'codereview-m1/PROMPT.md').read_text()
            meta = json.loads((output / 'codereview-m1/META.json').read_text())
            self.assertIn('## STANDING RULES (lean)', prompt)
            self.assertLess(len(prompt), len((KIT / 'tasks/codereview-m1/PROMPT.md').read_text()))
            self.assertEqual(meta['id'], 'codereview-m1')
            self.assertIs(meta['lean_prompt'], True)

    def test_unsupported_attack_role(self):
        with tempfile.TemporaryDirectory(dir=KIT.parent) as temporary:
            result = subprocess.run([sys.executable, '-B', str(KIT / 'bin/build_prompts.py'),
                                     '--lean', '--out', temporary, 'attack-m1'],
                                    cwd=KIT, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 2, 'unsupported lean role must refuse with exit 2')
            self.assertIn('attack', (result.stdout + result.stderr).decode(errors='replace').lower())


if __name__ == '__main__':
    unittest.main()
