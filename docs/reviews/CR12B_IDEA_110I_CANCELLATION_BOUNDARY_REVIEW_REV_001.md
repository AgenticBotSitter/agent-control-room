# CR12B-IDEA-110I cancellation-boundary independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `5c731e42bc54bc3dea88e079385b9616dd2042b4`

**Review checkout head:** `958f706c8b69730056ccef2cae6056dde0b4da9f`

**Frozen packet SHA-256:**
`1e16228a82d475941507213593c900ec94e0092054c53bdb9fcd18e97536e1ef`

## Independence and effect boundary

The fresh reviewer authored, advised, and repaired none of IDEA-110F through IDEA-110I and differed from every prior
connector and fixed-bridge reviewer. It reviewed exact repository source, used only in-memory test doubles and a removed
temporary out-of-tree probe, and retained sanitized evidence. It made no edit, commit, push, install, Hermes/native/SSH
attempt, credential or protected-value access, provider call, production-database contact, deployment, hosting, DNS, or
other consequential effect.

## Result

The reviewer independently reproduced all three IDEA-110H defects against `d22c76444b80f8dd469380aab52ec457f5d76fad`:

- invalid gateway cancellation was not rejected before permit spending;
- invalid bridge cancellation crossed validation and reached later processing; and
- native-signal poisoning escaped as an unsafe host error while ambient `AbortController` replacement leaked a unique
  sentinel.

The four intended IDEA-110I regressions passed at `5c731e4...`: gateway 1/1, bridge 1/1, and connector 2/2. The reviewer
then found one separate blocking host-operation gap.

## Finding

### CR12B-110I-REV001-FINDING-001 — Medium — mutable ambient Set executes after cancellation acceptance

**Exact source:** `src/idea-lab/v1/hermes-021-macos-connector.ts:117`, reached from the valid open path at old lines
201–209 before the protected private-call `try` began at old line 215.

**Reproducible input:** Import and warm the connector, replace `globalThis.Set` with a counting constructor that throws a
unique sentinel, then call `openFixedRoute` with an exact request and repository-minted opaque cancellation signal.

**Observed result:** `behavior=1`, `privateCalls=0`, `leakedSentinelIdentity=true`, `safeError=false`.

**Violated invariant / affected boundary:** A mutable ambient collection constructor remained selectable after module
import and after opaque cancellation acceptance. Its behavior executed and its exact exception escaped before safe-error
replacement. In the complete chain this point may occur after a one-use gateway permit has been claimed. This affects
host-operation capture, authority-domain distinctness, and bounded error replacement.

**Missing regression:** Post-import substitution covered `AbortController`, its getter, and abort method but not `Set`
or the remaining ambient host operations used by gateway, bridge, exact capture, and connector after cancellation
acceptance.

**Smallest safe remediation:** Replace dynamic Set distinctness with primitive comparisons; audit and capture or
structurally avoid every remaining ambient constructor, collection, time, number, JSON, object-freeze, reflection,
receiver-binding, Promise, and array-iteration operation on the accepted path. Add hostile post-import regressions that
require zero behavior and no sentinel escape.

## Verification

- packet hash matched;
- stage zero returned `ready_for_runtime_check`;
- TypeScript and lint passed;
- CR12B passed 158/158;
- the complete npm lifecycle passed;
- production build and 3/3 sequential rendered routes passed;
- 32 migrations and 110 PostgreSQL tables verified;
- diff validation and clean-tree validation passed.

Passing producer tests do not override the reproduced defect. IDEA-110I remains rejected and grants no connector,
native, provider, live-panel, deployment, or production authority.
