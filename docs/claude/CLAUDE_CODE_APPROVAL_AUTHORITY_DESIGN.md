# Claude Code approval callback — deferring to Control Room authority

Author: Claude (Opus 5). Date: 2026-09-13.
Status: **forward design proposal only.** Nothing here is being enabled, wired or
implemented now. No code, no endpoint, no credential, no operation-status change. Every
operation in `src/harness/claude-code-v1/connector-profile.ts` stays `unsupported`; this
document exists so that whoever picks up the Codex execution chain has the boundary written
down *before* Claude Code execution is scheduled, per `CLAUDE_CODE_HARNESS_PLAN.md` Stage B.

Inputs: `CLAUDE_CODE_HARNESS_PLAN.md` §5a (owner ruling), `CLAUDE_CODE_A0_VERIFICATION.md`
(live CLI behaviour), `docs/SHARED_CONNECTOR_CONTRACT.md`, `docs/SECURITY_CONFIGURATION_CONTRACT.md`,
and the real approval machinery in `src/completion-gate/v1/` on `main`.
Note: the two `docs/claude/` inputs currently live on unmerged branches
(`claude/claude-code-harness-plan`, `claude/claude-code-harness-a0`), not on `main`.

## 1. The shape of the problem

Claude Code is the only harness in the fleet that can stop mid-run and ask "may I do this?"
(a `canUseTool`-style callback) and that can be steered or interrupted while running. Codex
and Hermes can do neither. That is a capability, and it is also a hazard: an approval
question arriving mid-run wants an answer on a process timescale — seconds — while the only
legitimate source of that answer, a Control Room `approval_decision` record, is produced on a
human timescale by a strong-factor decision through Control Room's own interface.

Two clocks, one authority. The owner has already ruled (§5a) that Control Room wins outright
and the callback is a transport, never an approver. The unwritten part is the mechanism, and
the mechanism's whole job is to make sure the fast clock can never manufacture an answer the
slow clock did not produce.

## 2. What Control Room already has

The real machinery exists on `main` and does not need inventing:

- `ConsequentialApprovalRequestV1` — binds `tenantId`, `projectId`, `jobId`, `attemptId`,
  `effectIntentId`, `operationDigest`, `risk`, `requiredFactor: "strong"`, `requestedAt`,
  `expiresAt`. It carries `grantsExecutionAuthority: false`. Filing one is a proposal.
- `ConsequentialApprovalDecisionV1` — binds `requestId`, `requestDigest`, `operationDigest`,
  `policyDecisionId`, `decision`, `decidedBy` (`actorType: "human"`, enforced by the schema),
  `factor: "strong"`, `authenticationEventDigest`, `expiresAt`, `safeReasonCode`. It also
  carries `grantsExecutionAuthority: false` and `requiresSeparateNodeAttestation: true`.
- `CompletionGateStoreV1.requestApproval` / `.decideApproval`, which already reject anything
  whose binding, window, effect state, job authority (`effectPolicy: "approval_required"`,
  `allowedOperations`, `maxRisk`, `expiresAt`) or strong-factor evidence does not line up,
  with the safe code `approval_binding_invalid`.

So the design question is not "how do we build approval" but "how does a harness callback
*read* this without being able to write authority into it."

## 3. The mechanism

The callback handler is a lookup and a relay. It has three legal outcomes and no fourth.

**Before the run.** The attempt is launched under an already-bound job authority
(`allowedOperations`, `maxRisk`, `effectPolicy`, `expiresAt`). Approval is obtained *ahead*
of the run for effects that are known in advance. The mid-run callback is the exception path,
not the normal path. Claude Code is launched in a permission mode that forces the ask:
`--permission-mode` accepts six values on 2.1.270 (`acceptEdits`, `auto`, `bypassPermissions`,
`manual`, `dontAsk`, `plan`). Only `manual` and `plan` are candidates for a fleet node;
`bypassPermissions`, `dontAsk` and `auto` are disqualified outright, as are both spellings of
`--dangerously-skip-permissions`. `--restricted` should be evaluated as the default posture.

**When the callback fires**, the handler:

1. **Canonicalises the ask** — the tool name and its arguments — into the same operation
   shape Control Room already digests, producing a candidate `operationDigest`. It does not
   interpret intent; if the ask does not canonicalise deterministically, that is a refusal,
   not a judgement call (see §6, open question 1).
2. **Checks the pre-bound authority.** Is the operation in the attempt's `allowedOperations`,
   at or below `maxRisk`, inside `expiresAt`? If not → **deny**.
3. **Looks up an existing decision**, keyed by the exact `(tenant, project, jobId, attemptId,
   effectIntentId, operationDigest)` tuple: an `approval_decision` whose bound request matches
   that tuple, whose `decision` is `approved`, and whose `expiresAt` has not passed at this
   instant. If found → **allow**, and only as a relay of that record.
4. **If a matching request exists but no decision** → **deny, reason "pending"**. Not "wait
   while I decide" — the handler has nothing to decide with.
5. **If nothing matches** → the handler may file a `ConsequentialApprovalRequestV1` (a
   proposal; `grantsExecutionAuthority: false`) and **deny in the same breath**. Filing is not
   deciding, and the deny is returned immediately rather than held open.

The handler never constructs a decision, never infers one from an earlier related approval,
never widens scope, and never treats Claude Code's own phrasing of the request as evidence of
anything. Per the security contract, approval "cannot be inferred from login, chat text, an
agent's 'done' status or an earlier related task" — a `canUseTool` prompt is chat text.

Even a found approval is not execution authority: the decision record says
`grantsExecutionAuthority: false` and `requiresSeparateNodeAttestation: true`. The callback
allowing a tool call is the *harness* being permitted to proceed; the canonical effect is
still admitted by the effect-intent path, not by the callback's return value.

## 4. Ambiguity, timeout and lost answers

The security contract's rule is already written: "a timeout or closed connection is uncertain,
never permission to sign again automatically." Applied here:

- **Lookup timeout, store unavailable, transaction failure, ambiguous match, more than one
  candidate decision, clock skew past `expiresAt`** → return **deny**. Never allow. There is
  no configuration, environment or risk tier under which the fail-open branch exists, because
  it is not written.
- A deny is not silent. The attempt is marked as having hit an approval boundary
  (`waiting_approval` is already a job state the gate understands) and the ask surfaces in
  Control Room as a pending request for the owner to decide through the Control Room
  interface — not in Claude Code's own surface, per §5a.
- **The callback is never the waiting place.** It must not block on a human. If the owner
  later approves, the effect is carried out by a subsequent attempt or a steered continuation
  under the now-existing decision — not by a callback that stayed open for ten minutes and
  then returned allow. A deadline reached while a human deliberates is uncertainty, and
  uncertainty denies.
- Denies must be idempotent and must not trigger a looser retry. Submit-after-uncertainty
  rules from the shared connector contract apply unchanged: the handler re-asking with a
  broader scope, or the harness re-prompting until it gets a yes, are both failures.

## 5. Where this lands in the evidence model

`connectorOperationAdmissibleV1` requires `status: "supported"` **and** evidence of
`actual_interface_tested` or `native_qualified`. The relay is not an operation of its own; it
is a precondition on `submit` (and later `cancel`/`resume` if steering is used). Ladder:

- **`source_inspected`** — read the real callback surface in the installed package and confirm
  the ask's payload actually carries enough to canonicalise an operation digest. Note that the
  plain CLI cannot do this at all: per the plan's §4 phasing, `canUseTool` needs an in-process
  Agent SDK host, so this evidence level is about the SDK host, not `claude -p`.
- **`fixture_tested`** — replay recorded callback payloads against a fixture completion-gate
  store. Required cases: no request, request-without-decision, approved-and-valid,
  approved-but-expired, approved-for-a-different-digest, decision-for-a-different-attempt,
  two-candidate ambiguity, store unavailable, and canonicalisation failure. Every one except
  approved-and-valid must produce deny.
- **`actual_interface_tested`** — an authenticated run against the real CLI/SDK host in a
  worktree, where a real mid-run ask is denied because no decision exists, a real owner
  decision is recorded through Control Room, and a subsequent attempt proceeds under it. Plus
  the negative that matters most: an ask whose arguments differ from the approved ones by any
  byte must be denied on digest mismatch.

Until that last level exists, `submit` stays `unsupported` and this document stays design.

## 6. Deliberately left open

1. **Canonicalisation.** Turning a Claude Code tool call (`Bash` with a command string,
   `Edit` with a path and a patch) into the exact `operationDigest` Control Room's effect
   intents already use is the hard, unverified part. A near-miss canonicaliser is worse than
   none, because it makes an approval look reusable across asks that are not the same ask.
   Owner/Codex call, since Codex owns the effect-intent shape.
2. **Pre-binding granularity.** How much should be approved in advance per attempt versus
   left to deny-and-resubmit? Too coarse and the approval stops binding a real scope; too fine
   and every run stalls. Not mine to set.
3. **Whether mid-run asks are allowed at all in v1.** The strictest reading of §5a is that a
   fleet node runs only within pre-bound authority and treats any mid-run ask as a hard stop.
   That is simpler, provably safe, and gives up the capability. Owner's call.

## 7. What this document does not do

No code. No change to any operation status or evidence level. No credential, no endpoint, no
callback wired to anything. No claim that Claude Code execution is scheduled, approved or
imminent. It proposes one mechanism and names what would have to be proven before any of it
could be built.
