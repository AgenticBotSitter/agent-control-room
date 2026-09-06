"""Isolated source-level path-policy tests; NOT HTTP/authentication acceptance.

Python 3.12+: run with -I -B and the logged E06/E08 source directory argument.
FastAPI is absent here. Only its HTTPException/Request types are stood in; the
entire pinned upstream policy module is loaded unchanged. No web server import.
"""

import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


if len(sys.argv) != 2:
    raise SystemExit("Provide the logged source directory")
source = Path(sys.argv.pop()).resolve(strict=True) / "e08-hermes_cli-web_server_files.py"
if hashlib.sha256(source.read_bytes()).hexdigest() != "bbfddf761fe9949812e5eab53dad8288bbde55b0ef7662e5994df76b6edb0610":
    raise SystemExit("pinned_source_mismatch")
standin = types.ModuleType("fastapi")
standin.HTTPException = HTTPException
standin.Request = object
sys.modules["fastapi"] = standin
spec = importlib.util.spec_from_file_location("evaluated_managed_files", source)
policy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = policy
spec.loader.exec_module(policy)


class PathPolicyEvaluation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cr-e08-fixtures-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.allowed = self.root / "published"
        self.allowed.mkdir()
        self.inside = self.allowed / "report.md"
        self.inside.write_text("synthetic report", encoding="utf-8")
        self.outside = self.root / "not-published.md"
        self.outside.write_text("synthetic unrelated file", encoding="utf-8")
        self.env = patch.dict(os.environ, {"HERMES_DASHBOARD_FILES_ROOT": str(self.allowed)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def resolve(self, value, request=None):
        return policy._resolve_managed_path(value, request or object())

    def denied(self, path, code):
        with self.assertRaises(HTTPException) as raised:
            self.resolve(path)
        self.assertEqual(raised.exception.status_code, code)

    def test_locked_root_relative_file_resolves(self):
        result, path, _ = self.resolve("report.md")
        self.assertEqual(path, self.inside)
        self.assertEqual(result.locked_root, self.allowed)
        self.assertFalse(result.can_change_path)

    def test_locked_root_absolute_file_resolves(self):
        self.assertEqual(self.resolve(str(self.inside))[1], self.inside)

    def test_outside_absolute_file_denied(self):
        self.denied(str(self.outside), 403)

    def test_relative_parent_traversal_denied(self):
        self.denied("../not-published.md", 400)

    def test_symlink_escape_denied(self):
        (self.allowed / "link.md").symlink_to(self.outside)
        self.denied("link.md", 403)

    def test_sibling_prefix_is_not_containment(self):
        sibling = self.root / "published-other"
        sibling.mkdir()
        target = sibling / "report.md"
        target.write_text("synthetic", encoding="utf-8")
        self.denied(str(target), 403)

    def test_missing_file_and_nul_denied(self):
        self.denied("missing.md", 404)
        self.denied("bad\x00name", 400)

    def test_default_is_unlocked_not_home_containment(self):
        # Never uses the owner's home; override Path.home with a synthetic folder.
        os.environ.pop("HERMES_DASHBOARD_FILES_ROOT")
        with patch.object(Path, "home", return_value=self.allowed):
            result, path, _ = self.resolve(str(self.outside))
        self.assertIsNone(result.locked_root)
        self.assertTrue(result.can_change_path)
        self.assertEqual(path, self.outside)

    def test_request_project_is_not_an_authorization_input(self):
        one = types.SimpleNamespace(project_id="project-one")
        other = types.SimpleNamespace(project_id="project-other")
        self.assertEqual(self.resolve("report.md", one)[1], self.inside)
        self.assertEqual(self.resolve("report.md", other)[1], self.inside)


if __name__ == "__main__":
    unittest.main(verbosity=2)
