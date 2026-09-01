# CR12B-IDEA-110J host-operation capture independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `5707ecb05221e708beefa196fc0fa2e0c9d8515d`

**Review checkout head:** `bd82925a642d6d92eb720a27b846ebff10765c90`

**Frozen packet SHA-256:**
`f9f490e36c7f06ee74ae259b873a32cafe8fc8a73081ee48b2ccab46c5579abd`

## Independence and effect boundary

The reviewer was different from the IDEA-110I reviewer and every IDEA-110F through IDEA-110J contributor and prior
reviewer. It reviewed exact repository source, used a removed temporary out-of-tree in-memory probe, and retained only
sanitized evidence. It made no file edit, commit, push, install, external-service contact, native launch, SSH connection,
credential or protected-value access, provider call, production-database contact, deployment, hosting, DNS, or other
consequential effect.

## Result

The reviewer reproduced the rejected IDEA-110I ambient-Set behavior against `5c731e4...` and confirmed its closure at
`5707ecb...`: the exact new connector regression completed with zero hostile behavior, a normal private open, and
primitive pairwise distinctness across every authority domain. It then found one separate blocking shared-safety defect.

## Finding

### CR12B-110J-REV001-FINDING-001 — High — mutable Object.entries bypasses both safety walkers

**Exact source:** `src/idea-lab/v1/exact.ts:43-44` at the reviewed commit calls the two shared walkers, which dynamically
selected ambient operations in `src/security/redaction.ts:23-35` and `src/contracts/v1/validators.ts:119-145`.

**Reproducible input:** Confirm that a secret-bearing instruction normally returns `redaction_rejected`. After module
import, replace `Object.entries` with a counting function that returns an empty list and submit the same ordinary exact
value through the shared Idea Lab parser.

**Observed result:** `behavior=2`, `poisoned=passed`, `retained=true`. Both checks executed the replacement and accepted
the secret-bearing value unchanged.

**Violated invariant / affected boundary:** Exact capture cannot be safe if its final no-secret and safe-projection
checks can be made to traverse zero fields through mutable ambient operations. Gateway, bridge, and connector depend on
the shared parser; the bypass can retain forbidden content toward the Mac-private/provider path. This affects redaction,
safe projection, exact input/result validation, and the post-import host-operation selection boundary.

**Missing regression:** Existing host-substitution tests covered connector/gateway/bridge direct operations but not
`Object.entries`, `Array.isArray`, array `forEach`/`some`, regular-expression helpers, string normalization, or Error
construction through both safety walkers and the actual connector/provider/cleanup paths.

**Smallest safe remediation:** Capture or structurally avoid every host operation used by both walkers; use direct
indexed traversal and captured object, array, regular-expression, string, reflection, append/join, define-property, and
Error operations. Add direct walker regressions and end-to-end connector/provider/cleanup regressions that require zero
hostile behavior, retained rejection, no private prompt dispatch, and successful mandatory cleanup.

## Verification

- packet hash matched;
- stage zero returned `ready_for_runtime_check`;
- TypeScript and lint passed;
- CR12B passed 161/161;
- the complete npm lifecycle passed;
- production build and 3/3 sequential rendered routes passed;
- 32 migrations and 110 PostgreSQL tables verified;
- diff and clean-tree validation passed.

Passing producer tests do not override the reproduced defect. IDEA-110J remains rejected and grants no connector,
native, provider, live-panel, deployment, or production authority.
