# CR-5D disposable artifact storage contract

**Status:** Architect-frozen and implemented CR5D-STOR-002 for owner-created disposable roots  
**Decision date:** 2026-08-26  
**Scope:** Local artifact bytes in one private, pre-existing, disposable directory  
**Authority:** This contract does not create or select a live namespace, authorize deployment, or permit broad cleanup. A live root still requires exact owner authority.

## Root boundary

The adapter receives one absolute, already-canonical directory. It never creates, replaces, recursively cleans, or follows an alias to that directory. At construction and before each mutation it verifies the root is the same non-link directory object. On POSIX hosts the root must deny group and other permissions. Artifact identifiers never become path segments: their SHA-256 digest is the complete fixed-width filename, and locators expose only that digest.

This adapter is for an owner-created private disposable namespace. It is not a security boundary against a hostile process running as the same operating-system user. Native hostile-race and platform atomicity rehearsal remains a CR-5Q gate.

## Write boundary

Each artifact is limited to 64 KiB. Configured artifact-count and aggregate-byte limits are checked under an exclusive directory lock. In-process calls are serialized. Bytes are cloned into a mode-0600 temporary file, flushed, hard-linked to the final name without overwrite, directory-flushed, and only then is the temporary name removed. An existing final object is opened without following links, checked as a single-link regular file, re-read, and accepted only when size and content hash exactly match.

The adapter never silently repairs or deletes crash debris. A surviving lock, pending file, unexpected entry, symbolic link, additional hard link, changed root identity, or malformed stored object returns the fixed `storage_ambiguous` result. Exact cleanup and recovery require a separate inspected target and authority; no recursive or guessed cleanup API exists.

## Acceptance

- Exact bytes, content hash, size, private mode, and opaque locator agree.
- Exact retry is idempotent; different bytes under one artifact ID conflict.
- Count and aggregate-byte bounds hold across concurrent in-process requests.
- Public POSIX roots, aliases, unexpected crash debris, and linked objects fail closed.
- Tests use only individually created temporary directories and remove those exact directories afterward.
- TypeScript, ESLint, focused and full tests, and the rendered build pass.
