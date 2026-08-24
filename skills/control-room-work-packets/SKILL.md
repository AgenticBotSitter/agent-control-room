---
name: control-room-work-packets
description: Execute or independently review a bounded Control Room GitHub work packet while preserving authorization limits, evidence labels, cleanup obligations, file scope, and the no-self-merge rule. Use when an agent is assigned a Control Room implementation, qualification, probe, report-only, or contradiction-review issue; do not use to invent architecture, administer credentials, or expand a packet.
---

# Control Room worker packet

Treat the GitHub issue as an authorization contract, not a goal to satisfy by any available means. A useful blocked result is better than an out-of-scope success. Disclosing an extra effect afterward does not authorize it.

## Choose the mode

- For implementation, probe, qualification, fixture, or report-only work, follow **Execute a packet** and read [references/qualification-report.md](references/qualification-report.md) when the output includes a report.
- For an independent contradiction/review packet, follow **Review a packet** and read [references/independent-review.md](references/independent-review.md).
- If you authored any work you were assigned to review independently, stop and request reassignment. Do not create an “independence exception” unless the issue explicitly permits one.

## Coordinate before execution

1. Read the complete issue and every named repository instruction or immutable input.
2. Check open claims, branches, and PRs for the same packet or output paths. Do not duplicate active work.
3. Claim only work you are ready to start. Identify the real agent, machine class, harness, and proposed branch. Do not claim an entire batch merely to reserve it.
4. Refresh the required base and create one new branch from that base. Never branch from another worker branch or work directly on `main`.
5. Post concise status only at useful state changes: claimed, blocked, PR ready, or corrected. The Control Room record must remain sufficient even if chat history is unavailable.

Use repository-relative paths and repository-provided commands. Keep OS-, machine-, account-, credential-, and clone-specific setup in a separately authorized machine profile; never copy those details into this common skill.

## Compile the authorization before acting

The issue must contain a validated `control-room-work-packet/v1` execution contract. Read [references/execution-contract.md](references/execution-contract.md). If the contract is absent, invalid, not marked `ready`, uses an abbreviated base commit, or does not map every required step to effect IDs, the packet is non-actionable: stop before claiming or writing.

Before any write or external effect:

1. if the pinned commits are not already reachable, run only an explicitly contracted bootstrap-fetch effect; a generic GitHub-read allowance does not authorize `git fetch`;
2. run the contract validator and record its digest; the digest is over parsed, canonically serialized JSON, not Markdown formatting or line endings;
3. perform only read-only availability checks allowed by the contract;
4. build the worst-case occurrence table, including failed attempts, retries, diagnostics, setup, helper programs, prompts, and cleanup;
5. confirm every occurrence fits an effect ID and maximum count;
6. confirm the exact native cleanup method can verify identity, type, ownership/control, absence, and—when filesystem-backed—containment and link/reparse state without a glob or broad selector;
7. post a preflight acknowledgement containing the digest, real worker route, available tool versions, and `READY` or the exact blocking mismatch.

The architect-authored contract, not the worker's interpretation, controls execution. Workers cannot amend it in a comment or report. Any contract change creates a new digest and requires a fresh preflight. `READY` authorizes only the listed effects; it does not authorize a helpful setup or recovery action.

The contract must encode:

1. exact base commit and required branch;
2. exact allowed output paths;
3. authorized effects, including quantity, target boundaries, and retry consumption;
4. environment/setup policy for checkout, dependencies, downloads, network, prompts, restarts, elevation, persistent permissions, temporary files, and helpers;
5. required steps mapped to effect IDs and stop behavior;
6. forbidden effects and immutable contracts;
7. exact cleanup obligations and verification method;
8. required evidence, validation commands, independence exclusions, and blocked observations.

Cardinality is binding: “one disposable item” does not permit a second item, helper store, alternate account, or retry artifact. An authorized test does not implicitly authorize a reboot, persistent prompt choice, ACL/policy change, service/task, package/tool installation, repository clone, network download, dependency cache, temporary prompt file, or additional credential store. “Documentation only” constrains both committed output and local execution effects; it is not permission to create unrelated local artifacts.

Classify nested actions as effects too. Clicking **Always Allow**, changing a prompt policy, editing a supervisor, restarting a host/container, installing dependencies, creating helper binaries, or retaining diagnostic directories are separate effects even when they help the assigned test.

If a necessary action is absent or ambiguous, stop before it and comment on the issue with the exact additional authority needed. Do not infer permission from the expected outcome, risk label, worker identity, or ability to clean up later.

Run the deterministic validator on the exact JSON copied from the issue:

```text
python skills/control-room-work-packets/scripts/validate_execution_contract.py <contract.json>
```

The JSON is non-secret. If the harness needs a temporary file to run the validator, that file must itself be authorized by the contract and deleted before execution. Prefer passing the issue block through an in-memory/stdin facility supported by the harness.

The validator parses the JSON and hashes its canonical serialization (`sort_keys=True`, compact separators, UTF-8). Do not hash the raw fenced block: indentation and CRLF/LF normalization must not change the digest.

## Execute a packet

### Preflight

- Confirm the checkout is at the required base and the worktree contains no unrelated changes.
- Create only the required branch. Never work directly on `main`.
- Verify required tools without installing, updating, or reconfiguring them unless the issue explicitly permits that effect.
- Plan each disposable artifact before creation: exact path/name, type, sensitivity, owner, maximum count, and cleanup method.
- Use constants or newly generated disposable material. Never inspect or reuse production secrets.

### Authentication boundary

- Use only an already configured, approved authentication command such as `gh` or the repository's normal Git credential integration.
- Never call `git credential fill` to read a token, copy a password-manager value, export a token, assemble an `Authorization` header, place credentials in argv/environment/files, or teach another agent to do so.
- Never rotate, refresh, approve, synchronize, or migrate credentials as part of a work packet unless the issue expressly authorizes that separate security operation.
- If existing authenticated tooling is unavailable, stop and ask the owner to restore it. A missing convenience tool does not authorize direct token handling.

### During execution

- Stay within the allowed paths and effect count. Stop when the next step would cross either.
- Consume occurrences chronologically. The first matching occurrence consumes the budget; a later successful attempt cannot be designated retroactively as the authorized one.
- A failed attempt consumes its effects. Diagnostics are read-only unless the contract assigns them effect IDs. Never create an extra key, blob, directory, clone, helper, download, cache, or fixture to investigate a failure unless budget remains for that exact effect.
- Use the contract's `onFailure` behavior. `cleanup-then-stop` executes only the cleanup effect IDs attached to artifacts already created, then stops; it does not authorize diagnosis or retry. If it says `stop`, report the observed failure; do not repair the test harness, install a missing tool, or try a different representation.
- Keep secrets out of argv, environment variables, shell history, files, logs, reports, Git, issues, and PR text unless the packet explicitly authorizes a specific protected transport. Ciphertext and public material are not plaintext secrets, but still follow the packet’s handling rules.
- Map raw platform errors into fixed safe categories before recording them. Do not paste personal paths, account names, SIDs, hostnames, tokens, or raw security diagnostics.
- Maintain an append-only side-effect ledger as you work. Record failed attempts and diagnostic artifacts, not only the final successful run.
- Clean an artifact as soon as it is no longer needed. Before deletion, resolve and inspect the exact target, confirm it is packet-created and within the authorized temporary root, reject symlinks/junctions/reparse points or unexpected types, and delete only that exact target. Never use a broad cleanup glob.
- If cleanup fails or a file is locked, stop. Do not broaden the target, switch shells, escalate, or retry with a stronger primitive.
- Never weaken a check, alter an immutable contract, or substitute a different effect to turn a blocked observation into a pass.

### Evidence discipline

Use these meanings consistently:

- **observed** — directly produced by this run on the named host using the claimed real path;
- **documented** — supported by source, tests, or external documentation but not directly observed in this run;
- **inference** — reasoned from evidence and explicitly uncertain;
- **blocked** — required observation could not be performed safely or within authority;
- **unsupported** — stated conclusion lacks adequate evidence.

Source inspection is not host observation. A fake runner does not prove a native command. A new process is not a container restart; a container restart is not a host reboot. File modes under one UID do not prove cross-UID isolation. An absence check limited to the final scratch directory does not prove earlier attempt artifacts were removed.

Absolute claims such as “all,” “none,” “complete,” “clean,” “never,” or “fully” require evidence covering the entire stated scope. Otherwise narrow and label the claim.

Pin source citations to the exact commit reviewed. Recheck referenced lines immediately before handoff, and try to disprove negative or absolute conclusions with a repository-wide search.

### Optional author-side quality check

For a high-risk packet, a second model or agent may perform a read-only quality check only when that resource and its effects are authorized. It may challenge citations, scope, secrets, cleanup, and validation, but:

- it is not the packet's independent reviewer;
- it cannot approve, accept, merge, or expand the packet;
- it does not cure author overlap through a different model name;
- its prompt, temporary files, downloads, network calls, and logs remain ordinary effects subject to the ledger;
- its findings must be dispositioned honestly, including rejected suggestions.

### Finish and hand off

1. Reconcile the side-effect ledger. Inspect every created artifact individually and record removed, intentionally retained, blocked, or unknown.
2. Validate the actual occurrence ledger against the original contract digest. If any maximum is exceeded, effect ID is unknown, digest differs, or unexpected effect occurred, preserve the evidence and set the packet disposition to **rejected due to authorization deviation**. Do not call it accepted merely because it was disclosed or cleaned up.
3. Run the exact required validation commands. If a wrapper fails for a pre-existing reason, report its actual nonzero result; underlying commands may be diagnostic evidence but do not turn the wrapper into a pass. Do not edit configuration to make a gate pass unless authorized.
4. Run the deterministic scope checker after committing:

   ```text
   python skills/control-room-work-packets/scripts/verify_scope.py --base <base-ref> --branch <required-branch> --allow <exact-path> [--allow <exact-path> ...]
   ```

5. Inspect the final diff and secret-safe report. Push normally and open one PR for the packet. Check again that no duplicate PR exists. Never self-merge, self-approve, or force-push.
6. Link the PR from the issue and provide a concise handoff with the PR URL, head commit, changed paths, actual pass/fail/blocked state, cleanup state, and any failed attempts or self-corrections.
7. If branch history or scope is wrong after push, stop and request architect/owner handling. Do not use `reset --hard`, force-push, or history rewriting from this skill.

The PR description must reflect the current head. Update or supersede any withdrawn conclusion before requesting review; the report, PR body, issue comment, and actual ledger must not disagree.

For multiple packets, repeat the full loop sequentially: refresh the base, create a fresh branch, and open a separate PR for each packet. Read a dependency from its immutable commit or explicitly named PR ref; do not merge or copy unrelated files to obtain it.

## Review a packet

Check file scope before reading conclusions. Then verify authorization compliance, claim labels, side-effect inventory, cleanup evidence, source citations, contradictions, and validation results.

An author’s disclosure proves awareness, not permission. Mark any unapproved effect as an authorization deviation even when cleanup succeeded. Do not accept your own report, and do not treat an author-selected subreviewer as the independent reviewer required by the issue unless the packet permits that relationship.

Request focused repairs to the worker’s report or exact cleanup evidence. Do not rewrite their report, perform their host cleanup, alter provider/contract code, or merge. Detailed review criteria and the disposition format are in [references/independent-review.md](references/independent-review.md).

## Non-negotiable stop conditions

Stop and report rather than continue when:

- the next action is not expressly authorized;
- identity, target, path, effect count, or cleanup scope is uncertain;
- a required secret transport would use argv, environment, logs, or an unapproved file;
- the worktree contains unrelated changes that overlap the packet;
- a destructive target cannot be individually resolved and verified;
- a host/security setting, persistent permission, restart, installation, or escalation would be required but is not authorized;
- independence is violated;
- cleanup or a required gate fails and no authorized safe recovery exists.

