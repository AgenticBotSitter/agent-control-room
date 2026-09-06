"""Offline evaluation of pinned, unmodified Hermes fetch_file/fetch_realpath.

Usage: python3 -I -B scripts/research/hermes-file-fetch-evaluation.py SOURCE_DIR
Downloads are separate and logged. No Hermes runtime, profiles, backend SDKs or
gateway is started. Full upstream modules load through empty package namespaces;
only the execution environment is a test double running a bounded local shell.
"""

import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest


SOURCES = {
    "hermes_constants": ("hermes_constants.py", "492a78956930c5c385121b525b947fa50056c20666d01c431e2fd93436e793b0"),
    "hermes_cli._subprocess_compat": ("hermes_cli/_subprocess_compat.py", "625cfb9a1088eb8a50313e9b1a0b5a186cb582cc68ee9c8f9ee12580bf9e0144"),
    "tools.interrupt": ("tools/interrupt.py", "fc0e402eab50383407e1bf547503cdaf750545e97874ae12249bba1a1abc6deb"),
    "tools.environments.base_output": ("tools/environments/base_output.py", "e16963a309d74d5d4aee25299716ac6b536640b09b9d48fa756ea70a66bcaa0e"),
    "tools.environments.base_session_env": ("tools/environments/base_session_env.py", "1db42be8bead2c12d8e1ae3bccfc775148e0fda15aaf85d2b979cc01e62739b0"),
    "tools.environments.base_wait": ("tools/environments/base_wait.py", "8bfb5a97f1fd92a1c9a6f8e1c801473ef23caa6b767c9da7e3553ea86fc827c9"),
    "tools.environments.base": ("tools/environments/base.py", "3b4ac4db47ff700b48a447a4ebe396de070358134934cbd505cb9871070e0716"),
}


def load_sources(root):
    # Verify every file before executing any of it; no search of an installed Hermes.
    for filename, digest in SOURCES.values():
        content = (root / ("e07-" + filename.replace("/", "-"))).read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise RuntimeError("pinned_source_mismatch: " + filename)
    for name in ("hermes_cli", "tools", "tools.environments"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    for name, (filename, _) in SOURCES.items():
        path = root / ("e07-" + filename.replace("/", "-"))
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["tools.environments.base"]


def forbid_network(event, args):
    if event.startswith("socket."):
        raise RuntimeError("network_not_authorized_in_offline_evaluation")


if len(sys.argv) != 2:
    raise SystemExit("Provide the logged pinned-source directory")
if sys.version_info < (3, 12):
    raise SystemExit("Use Python 3.12+ for this pinned-source evaluation; no automatic install")
source_root = Path(sys.argv.pop()).resolve(strict=True)
sys.dont_write_bytecode = True
sys.addaudithook(forbid_network)
upstream = load_sources(source_root)


class LocalShell(upstream.BaseEnvironment):
    def __init__(self, root):
        # Intentionally no native BaseEnvironment initialization/session creation.
        self.root = root
        self.calls = 0

    def cleanup(self):
        pass

    def execute(self, command, **kwargs):
        self.calls += 1
        completed = subprocess.run(
            ["/bin/bash", "--noprofile", "--norc", "-c", command],
            cwd=self.root, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5,
        )
        return {"output": "synthetic login noise\n" + completed.stdout + completed.stderr,
                "returncode": completed.returncode}


class FetchEvaluation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cr-e07-fixtures-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = LocalShell(self.root)
        self.source = self.root / "input.bin"
        self.destination = self.root / "output.bin"

    def test_binary_roundtrip_at_exact_cap_with_shell_noise(self):
        payload = bytes(range(256)) * 40
        self.source.write_bytes(payload)
        self.env.fetch_file(str(self.source), self.destination, max_bytes=len(payload))
        self.assertEqual(self.destination.read_bytes(), payload)
        self.assertEqual(self.env.calls, 1)

    def test_empty_regular_file(self):
        self.source.write_bytes(b"")
        self.env.fetch_file(str(self.source), self.destination, max_bytes=20)
        self.assertEqual(self.destination.read_bytes(), b"")

    def test_spaces_quotes_and_shell_metacharacters_are_filename_data(self):
        source = self.root / "a quote' $data; report.bin"
        source.write_bytes(b"synthetic report")
        self.env.fetch_file(str(source), self.destination, max_bytes=100)
        self.assertEqual(self.destination.read_bytes(), b"synthetic report")

    def test_oversize_preserves_existing_destination(self):
        self.source.write_bytes(b"x" * 101)
        self.destination.write_bytes(b"prior-result")
        with self.assertRaisesRegex(upstream.FileFetchError, "exceeds"):
            self.env.fetch_file(str(self.source), self.destination, max_bytes=100)
        self.assertEqual(self.destination.read_bytes(), b"prior-result")

    def test_missing_file_does_not_create_output(self):
        with self.assertRaises(upstream.FileFetchError):
            self.env.fetch_file(str(self.source), self.destination, max_bytes=100)
        self.assertFalse(self.destination.exists())

    def test_directory_is_not_an_artifact(self):
        with self.assertRaises(upstream.FileFetchError):
            self.env.fetch_file(str(self.root), self.destination, max_bytes=100)
        self.assertFalse(self.destination.exists())

    def test_failed_command_and_unframed_payload_are_rejected_without_retry(self):
        class Failed(LocalShell):
            def execute(self, command, **kwargs):
                self.calls += 1
                return {"output": "truncated synthetic response", "returncode": 1}
        env = Failed(self.root)
        with self.assertRaises(upstream.FileFetchError):
            env.fetch_file(str(self.source), self.destination, max_bytes=100)
        self.assertEqual(env.calls, 1)
        self.assertFalse(self.destination.exists())

    def test_realpath_resolves_synthetic_symlink(self):
        self.source.write_bytes(b"synthetic")
        link = self.root / "link.bin"
        link.symlink_to(self.source)
        self.assertEqual(self.env.fetch_realpath(str(link)), str(self.source.resolve()))

    def test_corrupt_base64_rejected_before_destination_write(self):
        class Corrupt(LocalShell):
            def execute(self, command, **kwargs):
                response = super().execute(command, **kwargs)
                lines = response["output"].splitlines()
                marker = next(i for i, line in enumerate(lines) if line.startswith("__HERMES_FETCH_"))
                lines[marker + 1] = "invalid-base64!"
                response["output"] = "\n".join(lines)
                return response
        self.source.write_bytes(b"synthetic")
        with self.assertRaisesRegex(upstream.FileFetchError, "corrupted"):
            Corrupt(self.root).fetch_file(str(self.source), self.destination, max_bytes=100)
        self.assertFalse(self.destination.exists())

    def test_truncated_framing_rejected_even_with_success_exit(self):
        class Truncated(LocalShell):
            def execute(self, command, **kwargs):
                response = super().execute(command, **kwargs)
                response["output"] = response["output"].rsplit("__HERMES_FETCH_", 1)[0]
                return response
        self.source.write_bytes(b"synthetic")
        with self.assertRaises(upstream.FileFetchError):
            Truncated(self.root).fetch_file(str(self.source), self.destination, max_bytes=100)
        self.assertFalse(self.destination.exists())

    def test_realpath_command_failure_returns_none(self):
        class Failed(LocalShell):
            def execute(self, command, **kwargs):
                return {"output": "", "returncode": 1}
        self.assertIsNone(Failed(self.root).fetch_realpath(str(self.source)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
