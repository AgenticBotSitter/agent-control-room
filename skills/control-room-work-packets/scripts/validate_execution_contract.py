#!/usr/bin/env python3
"""Validate a Control Room execution contract and optional actual-effect ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any


VERSION = "control-room-work-packet/v1"
CONTROL_NAMES = {
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
}
POLICIES = {"forbidden", "preexisting-only", "authorized"}
RETRY_POLICIES = {"stop", "reuse-same", "consume-budget"}
FAILURE_POLICIES = {"stop", "reuse-same", "consume-budget"}
VERIFY_TOKENS = {
    "resolved",
    "contained",
    "expected-type",
    "owned",
    "not-link-or-reparse",
    "absent",
}


def load_object(source: str) -> dict[str, Any]:
    try:
        text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        value = json.loads(text)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read valid JSON from {source}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{source} must contain one JSON object")
    return value


def canonical_digest(contract: dict[str, Any]) -> str:
    encoded = json.dumps(contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def exact_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\\" in value or any(character in value for character in "*?[]"):
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and str(path) != "." and ".." not in path.parts and not value.startswith("./")


def nonempty_strings(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) and item.strip() for item in value)


def validate_contract(contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    required = {
        "contractVersion",
        "packetId",
        "issueNumber",
        "dispatchState",
        "baseCommit",
        "branch",
        "allowedPaths",
        "packetAuthors",
        "environment",
        "attemptPolicy",
        "effects",
        "steps",
        "forbiddenEffects",
        "gates",
        "independence",
    }
    missing = sorted(required - contract.keys())
    unknown = sorted(contract.keys() - required)
    errors.extend(f"missing:{name}" for name in missing)
    errors.extend(f"unknown:{name}" for name in unknown)

    if contract.get("contractVersion") != VERSION:
        errors.append("contractVersion:unsupported")
    if not isinstance(contract.get("packetId"), str) or not contract.get("packetId", "").strip():
        errors.append("packetId:invalid")
    if not isinstance(contract.get("issueNumber"), int) or contract.get("issueNumber", 0) <= 0:
        errors.append("issueNumber:invalid")
    if contract.get("dispatchState") != "ready":
        errors.append("dispatchState:not_ready")
    if not isinstance(contract.get("baseCommit"), str) or not re.fullmatch(r"[0-9a-f]{40}", contract.get("baseCommit", "")):
        errors.append("baseCommit:must_be_40_lower_hex")
    branch = contract.get("branch")
    if not isinstance(branch, str) or not branch.startswith("worker/") or branch.endswith("/") or branch == "main":
        errors.append("branch:invalid")
    allowed_paths = contract.get("allowedPaths")
    if not nonempty_strings(allowed_paths) or not all(exact_path(path) for path in allowed_paths or []):
        errors.append("allowedPaths:must_be_unique_exact_repo_paths")
    elif len(set(allowed_paths)) != len(allowed_paths):
        errors.append("allowedPaths:duplicates")
    if not nonempty_strings(contract.get("packetAuthors")):
        errors.append("packetAuthors:invalid")

    environment = contract.get("environment")
    effect_ids_from_environment: set[str] = set()
    if not isinstance(environment, dict):
        errors.append("environment:invalid")
    else:
        if set(environment) != CONTROL_NAMES:
            for name in sorted(CONTROL_NAMES - environment.keys()):
                errors.append(f"environment:{name}:missing")
            for name in sorted(environment.keys() - CONTROL_NAMES):
                errors.append(f"environment:{name}:unknown")
        for name in sorted(CONTROL_NAMES & environment.keys()):
            control = environment[name]
            if not isinstance(control, dict) or set(control) != {"policy", "effectIds"}:
                errors.append(f"environment:{name}:invalid_shape")
                continue
            policy = control.get("policy")
            ids = control.get("effectIds")
            if policy not in POLICIES or not isinstance(ids, list) or not all(isinstance(item, str) and item for item in ids):
                errors.append(f"environment:{name}:invalid")
                continue
            if policy == "authorized" and not ids:
                errors.append(f"environment:{name}:authorized_requires_effect")
            if policy != "authorized" and ids:
                errors.append(f"environment:{name}:non_authorized_has_effect")
            effect_ids_from_environment.update(ids)

    attempt = contract.get("attemptPolicy")
    if not isinstance(attempt, dict) or set(attempt) != {"maxTotalAttempts", "onExhaustion", "diagnostics"}:
        errors.append("attemptPolicy:invalid_shape")
    else:
        if not isinstance(attempt.get("maxTotalAttempts"), int) or attempt.get("maxTotalAttempts", 0) <= 0:
            errors.append("attemptPolicy:maxTotalAttempts_invalid")
        if attempt.get("onExhaustion") != "stop":
            errors.append("attemptPolicy:onExhaustion_must_stop")
        if attempt.get("diagnostics") not in {"read-only", "effect-budget-only"}:
            errors.append("attemptPolicy:diagnostics_invalid")

    effects = contract.get("effects")
    effect_map: dict[str, dict[str, Any]] = {}
    if not isinstance(effects, list) or not effects:
        errors.append("effects:invalid")
    else:
        required_effect = {"id", "action", "maxOccurrences", "targets", "retryPolicy", "createsArtifact", "cleanup"}
        for index, effect in enumerate(effects):
            prefix = f"effects:{index}"
            if not isinstance(effect, dict) or set(effect) != required_effect:
                errors.append(f"{prefix}:invalid_shape")
                continue
            effect_id = effect.get("id")
            if not isinstance(effect_id, str) or not re.fullmatch(r"E-[A-Z0-9][A-Z0-9-]*", effect_id):
                errors.append(f"{prefix}:id_invalid")
                continue
            if effect_id in effect_map:
                errors.append(f"effects:duplicate:{effect_id}")
                continue
            effect_map[effect_id] = effect
            if not isinstance(effect.get("action"), str) or not effect["action"].strip():
                errors.append(f"{prefix}:action_invalid")
            if not isinstance(effect.get("maxOccurrences"), int) or effect["maxOccurrences"] <= 0:
                errors.append(f"{prefix}:maxOccurrences_invalid")
            if not nonempty_strings(effect.get("targets")):
                errors.append(f"{prefix}:targets_invalid")
            if effect.get("retryPolicy") not in RETRY_POLICIES:
                errors.append(f"{prefix}:retryPolicy_invalid")
            if not isinstance(effect.get("createsArtifact"), bool):
                errors.append(f"{prefix}:createsArtifact_invalid")
            cleanup = effect.get("cleanup")
            if effect.get("createsArtifact"):
                if not isinstance(cleanup, dict) or set(cleanup) != {"method", "verify"}:
                    errors.append(f"{prefix}:cleanup_required")
                elif cleanup.get("method") != "exact-target-native" or set(cleanup.get("verify", [])) != VERIFY_TOKENS:
                    errors.append(f"{prefix}:cleanup_not_exact_or_complete")
            elif cleanup is not None:
                errors.append(f"{prefix}:cleanup_must_be_null")

    for effect_id in sorted(effect_ids_from_environment - effect_map.keys()):
        errors.append(f"environment:unknown_effect:{effect_id}")

    steps = contract.get("steps")
    referenced_effects = set(effect_ids_from_environment)
    if not isinstance(steps, list) or not steps:
        errors.append("steps:invalid")
    else:
        seen_steps: set[str] = set()
        for index, step in enumerate(steps):
            prefix = f"steps:{index}"
            if not isinstance(step, dict) or set(step) != {"id", "description", "effectIds", "onFailure"}:
                errors.append(f"{prefix}:invalid_shape")
                continue
            step_id = step.get("id")
            if not isinstance(step_id, str) or not re.fullmatch(r"S[0-9]+", step_id) or step_id in seen_steps:
                errors.append(f"{prefix}:id_invalid_or_duplicate")
            else:
                seen_steps.add(step_id)
            if not isinstance(step.get("description"), str) or not step["description"].strip():
                errors.append(f"{prefix}:description_invalid")
            ids = step.get("effectIds")
            if not isinstance(ids, list) or not all(isinstance(item, str) and item for item in ids):
                errors.append(f"{prefix}:effectIds_invalid")
                ids = []
            for effect_id in ids:
                if effect_id not in effect_map:
                    errors.append(f"{prefix}:unknown_effect:{effect_id}")
                referenced_effects.add(effect_id)
            if step.get("onFailure") not in FAILURE_POLICIES:
                errors.append(f"{prefix}:onFailure_invalid")

    for effect_id in sorted(effect_map.keys() - referenced_effects):
        errors.append(f"effects:unreferenced:{effect_id}")

    max_attempts = attempt.get("maxTotalAttempts", 0) if isinstance(attempt, dict) else 0
    retry_requested = any(
        effect.get("retryPolicy") == "consume-budget"
        for effect in effect_map.values()
    ) or any(
        isinstance(step, dict) and step.get("onFailure") == "consume-budget"
        for step in steps or []
    )
    if retry_requested and (not isinstance(max_attempts, int) or max_attempts < 2):
        errors.append("attemptPolicy:retry_requires_multiple_attempts")
    for effect_id, effect in effect_map.items():
        if effect.get("retryPolicy") == "consume-budget" and effect.get("maxOccurrences", 0) < 2:
            errors.append(f"effects:retry_without_occurrence_budget:{effect_id}")

    if not nonempty_strings(contract.get("forbiddenEffects")):
        errors.append("forbiddenEffects:invalid")
    if not nonempty_strings(contract.get("gates")):
        errors.append("gates:invalid")
    independence = contract.get("independence")
    if not isinstance(independence, dict) or set(independence) != {"required", "excludedAuthors"}:
        errors.append("independence:invalid_shape")
    else:
        required_independence = independence.get("required")
        excluded = independence.get("excludedAuthors")
        if not isinstance(required_independence, bool) or not isinstance(excluded, list) or not all(isinstance(item, str) and item for item in excluded):
            errors.append("independence:invalid")
        elif required_independence and not excluded:
            errors.append("independence:required_without_exclusions")
    return sorted(set(errors))


def validate_actual(contract: dict[str, Any], digest: str, actual: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if set(actual) != {"contractDigest", "occurrences", "unexpectedEffects"}:
        errors.append("actual:invalid_shape")
        return errors
    if actual.get("contractDigest") != digest:
        errors.append("actual:contract_digest_mismatch")
    unexpected = actual.get("unexpectedEffects")
    if not isinstance(unexpected, list):
        errors.append("actual:unexpectedEffects_invalid")
    elif unexpected:
        errors.append("actual:unexpected_effects_present")
    effect_limits = {effect["id"]: effect["maxOccurrences"] for effect in contract.get("effects", []) if isinstance(effect, dict) and "id" in effect}
    occurrences = actual.get("occurrences")
    if not isinstance(occurrences, list):
        errors.append("actual:occurrences_invalid")
        return sorted(set(errors))
    totals: dict[str, int] = {}
    for index, occurrence in enumerate(occurrences):
        if not isinstance(occurrence, dict) or set(occurrence) != {"effectId", "count"}:
            errors.append(f"actual:occurrences:{index}:invalid_shape")
            continue
        effect_id = occurrence.get("effectId")
        count = occurrence.get("count")
        if effect_id not in effect_limits:
            errors.append(f"actual:unknown_effect:{effect_id}")
            continue
        if not isinstance(count, int) or count < 0:
            errors.append(f"actual:count_invalid:{effect_id}")
            continue
        totals[effect_id] = totals.get(effect_id, 0) + count
    for effect_id, total in totals.items():
        if total > effect_limits[effect_id]:
            errors.append(f"actual:over_budget:{effect_id}:{total}>{effect_limits[effect_id]}")
    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", help="contract JSON path, or - for stdin")
    parser.add_argument("--actual", help="actual-effect ledger JSON path, or - for stdin")
    args = parser.parse_args()
    if args.contract == "-" and args.actual == "-":
        parser.error("contract and actual cannot both read from stdin")
    try:
        contract = load_object(args.contract)
        errors = validate_contract(contract)
        digest = canonical_digest(contract)
        actual_errors: list[str] = []
        if args.actual is not None and not errors:
            actual_errors = validate_actual(contract, digest, load_object(args.actual))
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    report = {
        "ok": not errors and not actual_errors,
        "contractVersion": contract.get("contractVersion"),
        "packetId": contract.get("packetId"),
        "contractDigest": digest,
        "contractErrors": errors,
        "actualErrors": actual_errors,
    }
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

