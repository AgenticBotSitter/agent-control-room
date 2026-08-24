#!/usr/bin/env python3
"""Verify that a work-packet branch changes only exact authorized paths."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import PurePosixPath


def git(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def lines(*arguments: str) -> set[str]:
    output = git(*arguments).stdout
    return {line.replace("\\", "/") for line in output.splitlines() if line}


def normalize_allowed(value: str) -> str:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or str(path) == "."
        or path.is_absolute()
        or ".." in path.parts
        or normalized.startswith("./")
        or any(character in normalized for character in "*?[]")
    ):
        raise argparse.ArgumentTypeError("allowed paths must be exact repository-relative paths")
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Base ref or commit named by the packet")
    parser.add_argument("--branch", required=True, help="Exact required branch name")
    parser.add_argument("--allow", action="append", required=True, type=normalize_allowed, help="Exact allowed changed path; repeat as needed")
    parser.add_argument("--permit-no-change", action="store_true")
    args = parser.parse_args()

    try:
        git("rev-parse", "--verify", f"{args.base}^{{commit}}")
        base_is_ancestor = git("merge-base", "--is-ancestor", args.base, "HEAD", check=False).returncode == 0
        actual_branch = git("branch", "--show-current").stdout.strip()
        committed = lines("diff", "--name-only", "--diff-filter=ACMRDTUXB", f"{args.base}...HEAD")
        working = lines("diff", "--name-only", "--diff-filter=ACMRDTUXB")
        staged = lines("diff", "--cached", "--name-only", "--diff-filter=ACMRDTUXB")
        untracked = lines("ls-files", "--others", "--exclude-standard")
    except subprocess.CalledProcessError as error:
        print(json.dumps({"ok": False, "error": "git_command_failed", "detail": error.stderr.strip()}))
        return 2

    changed = committed | working | staged | untracked
    allowed = set(args.allow)
    unauthorized = sorted(changed - allowed)
    missing = sorted(allowed - changed)
    errors: list[str] = []
    if actual_branch != args.branch:
        errors.append("branch_mismatch")
    if not base_is_ancestor:
        errors.append("base_not_ancestor")
    if unauthorized:
        errors.append("unauthorized_paths")
    if working or staged or untracked:
        errors.append("uncommitted_changes")
    if not changed and not args.permit_no_change:
        errors.append("no_changes_detected")

    checks = []
    for command in [
        ("diff", "--check", f"{args.base}...HEAD"),
        ("diff", "--check"),
        ("diff", "--cached", "--check"),
    ]:
        result = git(*command, check=False)
        checks.append({"command": ["git", *command], "exitCode": result.returncode, "output": result.stdout.strip() or result.stderr.strip()})
        if result.returncode != 0:
            errors.append("diff_check_failed")

    report = {
        "ok": not errors,
        "base": args.base,
        "requiredBranch": args.branch,
        "actualBranch": actual_branch,
        "baseIsAncestor": base_is_ancestor,
        "allowed": sorted(allowed),
        "changed": sorted(changed),
        "unauthorized": unauthorized,
        "allowedButUnchanged": missing,
        "checks": checks,
        "errors": sorted(set(errors)),
    }
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
