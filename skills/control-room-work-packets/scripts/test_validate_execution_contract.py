#!/usr/bin/env python3
"""Regression tests for the execution-contract validator."""

from __future__ import annotations

import copy
import unittest

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
                    "method": "exact-target-native",
                    "verify": ["resolved", "contained", "expected-type", "owned", "not-link-or-reparse", "absent"],
                },
            }
        ],
        "steps": [{"id": "S1", "description": "run once", "effectIds": ["E-SCRATCH"], "onFailure": "stop"}],
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


if __name__ == "__main__":
    unittest.main()

