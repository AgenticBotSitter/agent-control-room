#!/usr/bin/env python3
"""Regression tests for the execution-contract validator."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from validate_execution_contract import canonical_digest, validate_actual, validate_contract


def valid_contract() -> dict:
    controls = {
        name: {"policy": "forbidden", "effectIds": []}
        for name in [
            "checkout",
            "dependencies",
            "toolDownloads",
            "network",
            "prompts",
            "restarts",
            "privilegeEscalation",
            "persistentPermissions",
            "temporaryFiles",
            "helperPrograms",
        ]
    }
    controls["temporaryFiles"] = {"policy": "authorized", "effectIds": ["E-SCRATCH"]}
    return {
        "contractVersion": "control-room-work-packet/v1",
        "packetId": "CR-TEST-1",
        "issueNumber": 1,
        "dispatchState": "ready",
        "baseCommit": "0" * 40,
        "branch": "worker/test/1-contract",
        "allowedPaths": ["docs/result.md"],
        "packetAuthors": ["architect"],
        "environment": controls,
        "attemptPolicy": {"maxTotalAttempts": 1, "onExhaustion": "stop", "diagnostics": "read-only"},
        "effects": [
            {
                "id": "E-SCRATCH",
                "action": "create one scratch directory",
                "maxOccurrences": 1,
                "targets": ["one OS temporary child"],
                "retryPolicy": "stop",
                "createsArtifact": True,
                "cleanup": {
                    "effectId": "E-SCRATCH-CLEANUP",
                    "method": "exact-target-native",
                    "verify": ["resolved", "contained", "expected-type", "owned", "not-link-or-reparse", "absent"],
                },
            },
            {
                "id": "E-SCRATCH-CLEANUP",
                "action": "delete and verify the one scratch directory",
                "maxOccurrences": 1,
                "targets": ["the packet-created OS temporary child"],
                "retryPolicy": "stop",
                "createsArtifact": False,
                "cleanup": None,
            },
        ],
        "steps": [
            {"id": "S1", "description": "run once", "effectIds": ["E-SCRATCH"], "onFailure": "cleanup-then-stop"},
            {"id": "S2", "description": "clean once", "effectIds": ["E-SCRATCH-CLEANUP"], "onFailure": "stop"},
        ],
        "forbiddenEffects": ["everything not listed"],
        "gates": ["git diff --check must exit 0"],
        "independence": {"required": False, "excludedAuthors": []},
    }


class ExecutionContractTests(unittest.TestCase):
    def test_valid_contract_and_actual_ledger(self) -> None:
        contract = valid_contract()
        digest = canonical_digest(contract)
        self.assertEqual(validate_contract(contract), [])
        self.assertEqual(
            validate_actual(
                contract,
                digest,
                {"contractDigest": digest, "occurrences": [{"effectId": "E-SCRATCH", "count": 1}], "unexpectedEffects": []},
            ),
            [],
        )

    def test_over_budget_and_digest_drift_fail(self) -> None:
        contract = valid_contract()
        errors = validate_actual(
            contract,
            canonical_digest(contract),
            {"contractDigest": "bad", "occurrences": [{"effectId": "E-SCRATCH", "count": 2}], "unexpectedEffects": []},
        )
        self.assertIn("actual:contract_digest_mismatch", errors)
        self.assertIn("actual:over_budget:E-SCRATCH:2>1", errors)

    def test_implicit_setup_and_wildcard_paths_fail(self) -> None:
        contract = valid_contract()
        contract["allowedPaths"] = ["docs/*.md"]
        contract["environment"]["toolDownloads"] = {"policy": "authorized", "effectIds": []}
        errors = validate_contract(contract)
        self.assertIn("allowedPaths:must_be_unique_exact_repo_paths", errors)
        self.assertIn("environment:toolDownloads:authorized_requires_effect", errors)

    def test_unknown_effect_and_unreferenced_effect_fail(self) -> None:
        contract = valid_contract()
        extra = copy.deepcopy(contract["effects"][0])
        extra["id"] = "E-EXTRA"
        contract["effects"].append(extra)
        contract["steps"][0]["effectIds"] = ["E-MISSING"]
        errors = validate_contract(contract)
        self.assertIn("steps:0:unknown_effect:E-MISSING", errors)
        self.assertIn("effects:unreferenced:E-EXTRA", errors)

    def test_independent_review_requires_excluded_authors(self) -> None:
        contract = valid_contract()
        contract["independence"] = {"required": True, "excludedAuthors": []}
        self.assertIn("independence:required_without_exclusions", validate_contract(contract))

    def test_retry_requires_attempt_and_effect_budget(self) -> None:
        contract = valid_contract()
        contract["effects"][0]["retryPolicy"] = "consume-budget"
        contract["steps"][0]["onFailure"] = "consume-budget"
        errors = validate_contract(contract)
        self.assertIn("attemptPolicy:retry_requires_multiple_attempts", errors)
        self.assertIn("effects:retry_without_occurrence_budget:E-SCRATCH", errors)

        contract["attemptPolicy"]["maxTotalAttempts"] = 2
        contract["effects"][0]["maxOccurrences"] = 2
        self.assertEqual(validate_contract(contract), [])

    def test_exact_named_resource_cleanup_is_distinct_from_filesystem_cleanup(self) -> None:
        contract = valid_contract()
        contract["effects"][0]["cleanup"] = {
            "effectId": "E-SCRATCH-CLEANUP",
            "method": "exact-resource-native",
            "verify": ["identified", "expected-type", "controlled", "no-broad-selector", "absent"],
        }
        self.assertEqual(validate_contract(contract), [])

        contract["effects"][0]["cleanup"]["verify"].remove("no-broad-selector")
        self.assertIn("effects:0:cleanup_not_exact_or_complete", validate_contract(contract))

    def test_cleanup_requires_a_separate_non_artifact_effect(self) -> None:
        contract = valid_contract()
        contract["effects"][0]["cleanup"]["effectId"] = "E-MISSING"
        self.assertIn("effects:cleanup_unknown_effect:E-SCRATCH:E-MISSING", validate_contract(contract))

        contract = valid_contract()
        contract["effects"][0]["cleanup"]["effectId"] = "E-SCRATCH"
        self.assertIn("effects:cleanup_self_reference:E-SCRATCH", validate_contract(contract))

    def test_cr5c9_host_contracts_are_valid_and_digest_pinned(self) -> None:
        root = Path(__file__).resolve().parents[3]
        expected = {
            "CR5C9Q_MACOS_KEYCHAIN_V1.json": "c0742f563b9fe20f590b19be85e4a466dd23b89d18f77d6dcb841569115ac50e",
            "CR5C9Q_WINDOWS_DPAPI_V1.json": "2c1f99337caa7817b363841e277edb34d851455f9f1a7874f36a7b876107504f",
            "CR5C9Q_LINUX_ENCRYPTED_FILE_V1.json": "63af12ff3bf270dd6186496966589a2bf2d0d77f448ffb40ab65520fd5f63390",
        }
        for filename, digest in expected.items():
            contract = json.loads((root / "docs" / "qualification-packets" / filename).read_text(encoding="utf-8"))
            self.assertEqual(validate_contract(contract), [], filename)
            self.assertEqual(canonical_digest(contract), digest, filename)


if __name__ == "__main__":
    unittest.main()

