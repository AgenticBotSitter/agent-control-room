# CR12B-IDEA-110N formatter and roster-capture independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `58fc3304b8b927252c6c0d0e3d8afc9c1b2039b5`

**Review checkout head:** `fc299c276ea95b7beab8f9c1cc508c1d882ef93a`

**Frozen packet SHA-256:**
`c561cf781d944ec01943f5fd412adf64ad59e8dd61ab6a3205f815aab346804f`

## Independence and effect boundary

The reviewer was different from every completed IDEA-110K through IDEA-110M reviewer and every IDEA-110F through
IDEA-110N contributor. Exact products were inspected from isolated Git archives. No repository edit, commit, push,
install, download, network request, Hermes/native launch, SSH connection, provider call, credential/protected-value
access, production-database contact, deployment, hosting, or DNS effect occurred. Temporary archives and probes were
removed, and the primary checkout remained clean.

## Closed inherited findings

The reviewer reproduced both IDEA-110M findings against rejected product
`790524a7538f0e1d6c45e5023f5ecc3100e9c113` and confirmed that IDEA-110N closed them. Extended years, both Date limits,
and invalid Date values returned controlled `undefined`; real evidence expiry retained an exact 300000-millisecond
interval. Caller-array traversal executed zero hostile behavior, exact arrays through 32 items retained correct counts,
and non-exact roster topologies failed closed. The reviewer also reproduced the IDEA-110L chronology failures and passed
the 91-test inherited security subset. These closures do not override the new finding below.

## Finding

### CR12B-110N-REV001-FINDING-001 — Medium — roster digest still invoked mutable ambient array behavior

**Exact source:** `src/idea-lab/v1/hermes-021-enrolled-connection.ts:353` and
`src/security/digest.ts:40-52` at the reviewed product.

**Reproducible input:** After module import, replace `Array.prototype.map` with a selective implementation that delegates
for every receiver except the repository-created array of parsed connection records. For that receiver, increment a
counter and throw a unique sentinel. Then build a valid two-connection roster from an exact ordinary caller array.

**Observed result:** The targeted replacement executed once and `REVIEW_DIGEST_MAP_SENTINEL` escaped. A tracing run
observed 132 ambient `map` selections during construction: 122 inside dependency-owned Zod parsing and 10 inside the
repository canonicalizer. The targeted raw sentinel escaped through the roster digest calculation.

**Violated invariant / affected boundary:** The roster path must select no mutable ambient repository helper and leak no
raw sentinel after capturing caller data. IDEA-110N safely rebuilt the roster, then passed that repository-owned array
to `sha256Digest`, whose canonicalizer dynamically called `map` and `join`. Shared-state mutation could interrupt or
alter the roster digest. Native qualification, live-panel eligibility, and execution authority remained false, limiting
severity to Medium.

**Missing regression:** The IDEA-110N replacement trapped `map` only when its receiver was the original caller array; it
delegated every call on the repository-created parsed-connections array.

**Smallest safe remediation:** Compute the roster digest through module-captured canonical operations or a
roster-specific captured canonical digest with identical clean-runtime output. Add a regression targeting the rebuilt
parsed-connections receiver and require zero hostile calls, no raw sentinel, and a stable verifiable digest.

## Verification

macOS stage zero, TypeScript, lint, CR12B 169/169, the complete lifecycle with 769/769 pretests, 418 core passes plus two
intentional platform skips, 248/248 posttests, the 91/91 inherited security subset, production build, 3/3 rendered
routes, all 32 migrations/110 PostgreSQL tables, and whitespace validation passed. Producer gates do not override the
finding. IDEA-110N remains rejected and grants no connector, native, provider, live-panel, deployment, or production
authority.
