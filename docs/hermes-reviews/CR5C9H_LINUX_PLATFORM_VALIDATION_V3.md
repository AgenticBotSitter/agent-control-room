# CR-5C.9H-Q3 Linux platform validation v3 (Johnny5)

**Disposition:** `met`

## Header

- Issue / block: #120 — CR-5C.9H Linux platform validation v3
- Worker: Johnny5 — Hermes Agent (`ox-alpha` via provider `nous`); Hostinger Ubuntu VPS container (headless Linux, uid 0)
- Base: `0480cc4e4a54efd18a4152f2787b31b5a7da0de7` (verified reachable and ancestor of `origin/main` after exactly one bootstrap fetch)
- Branch: `worker/johnny5/cr5c9h-linux-v3`
- Allowed committed path: this report only
- Native attempt policy: one execution; no rerun/repair/substitute
- Harness sha256: `0e3eef4ccd8fdd0ed980632db4b63ea3d19d6cf4a8523fd1939814f821bccb94` (readiness artifact)
- Public key fingerprint: `4bbf79d0105bd288ec6255e77802e6d6696fab5dcad73b25f6db0eb2e262f4c2`

## Phase 0 — stage zero and setup (separate from native attempt)

| Step | Exit | Outcome |
|---|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform linux` (cold) | 2 | `setup_required`, missing=`["tsx","zod"]`, build policy verified (esbuild/sharp/workerd all `false`) |
| `CI=true pnpm install --frozen-lockfile --offline` | 0 | offline-cache complete in 2.3s, no online fallback needed |
| Stage-zero rerun (after install) | 0 | `ready_for_runtime_check`, resolved=`["tsx","zod"]` |

## Phase 1 — runtime readiness

| Step | Exit | Outcome |
|---|---|---|
| `node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform linux` | 0 | `ready:true`, all 8 checks pass (working_directory, repository_identity, node_runtime, tsx_module_resolution, qualification_harness, scratch_parent, native_tool, output_contract) |

## Phase 2 — one native execution

Exact command (cwd = repository root):

```text
node --import tsx scripts/qualification/platform-key-store-harness.ts --platform linux --scratch <exact-empty-temp-child>
```

- Exit code: **0**
- `passed: true`
- Provider: `encrypted_file`, implementation: `createNodePrivateKeyStore`, attempt: 1
- Counts: `keypairs=1, wrapKeys=1, childProcesses=1, harnessRuns=1, scratchFiles=6, scratchSymlinks=1`
- Public key fingerprint: `4bbf79d0105bd288ec6255e77802e6d6696fab5dcad73b25f6db0eb2e262f4c2`

### Cases observed (11/11 pass)

| id | status | category |
|---|---|---|
| protected_file_availability | pass | available |
| protected_file_sign_verify | pass | ed25519 |
| lock_sign_refusal | pass | key_not_unlocked |
| fresh_child_fd_sign_verify | pass | ed25519 |
| tampered_tag_refusal | pass | corrupt |
| wrong_key_refusal | pass | corrupt |
| mode_drift_refusal | pass | permission_denied |
| symlink_refusal | pass | permission_denied |
| missing_secret_refusal | pass | missing |
| descriptor_31_refusal | pass | invalid_configuration |
| descriptor_33_refusal | pass | invalid_configuration |

## Side effects and cleanup proof

One exact scratch: `/tmp/control-room-cr5c9h-linux-v3-e7ryee9t`, mode 0700, direct child of OS temp dir, owned by executing UID, no symlinks at the scratch root itself. Pre-delete checks: resolved=canonical, parent=`/tmp`, type=directory, not-link, owned — all true. Children enumerated without following the contained symlink:

- 6 regular files: `encrypted-key.json`, `encrypted-key-tampered.json`, `wrap.key`, `wrap-wrong.key`, `wrap-31.key`, `wrap-33.key`
- 1 symlink (not followed): `wrap-link.key`

Exact-target `rmtree` then `absent_after=True` (verified). Nothing retained. No broad cleanup.

Setup persistence: `node_modules/` (and pnpm-managed `.pnpm/` store links) persisted in this checkout as authorized by Phase 0 — this checkout is the worker-local execution environment, not the repository source tree.

Other native effects: one fresh Node child process spawned with exactly one inherited file descriptor; no secrets passed via argv or environment; one Ed25519 keypair and one 32-byte wrap key generated and used in memory and discarded by process exit; one mode drift mutation (`0600→0644→0600`) on `wrap.key`; one contained symlink create.

No chown, no UID switch, no container/host restart, no service/cgroup/capability/seccomp change, no elevation, no persistent configuration, no credential publication, no force-push.

## Limitations / deferred

- Fresh-process evidence is for one UID only; alternate-UID ownership isolation is deferred to CR-6A (not exercised here).
- Container/host restart unlock behavior is not claimed by this run; this proves fresh-process separation only.
- Online `pnpm install` fallback was **not** required; offline cache was sufficient.

## Validation

| Command | Exit | Result |
|---|---|---|
| `git diff --check 0480cc4e4a54efd18a4152f2787b31b5a7da0de7...HEAD` | 0 | clean |
| `python3 skills/control-room-work-packets/scripts/verify_scope.py --base 0480cc4e4a54efd18a4152f2787b31b5a7da0de7 --branch worker/johnny5/cr5c9h-linux-v3 --allow docs/hermes-reviews/CR5C9H_LINUX_PLATFORM_VALIDATION_V3.md` | 0 | `ok=true`, only allowed path changed |

## Disposition

**`met`** — the qualification harness passed on first execution with all 11 cases green; no rerun, repair, or scope deviation was required. PR ready for Codex/Sol review.