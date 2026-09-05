# CR14C private task results and recorded review integration

Status: implementation candidate. Lead: Astra Xhigh. This continues C-WORK; it does not activate a host.

## End-to-end repository path

Connect a completed native result to the existing task page: authenticate the existing signed native
snapshot, require its exact recorded run/attempt binding, check at most 65,536 UTF-8 bytes against its
hash/size claim, store/read back the bytes through an explicitly supplied approved artifact store, and
atomically record an existing canonical artifact manifest plus a private integrity-protected receipt.
The metadata remains PostgreSQL-authoritative; bytes remain approved local/R2 artifact storage, not a
new coordination database. No new native execution or protocol authority is introduced.

One deterministic artifact identity belongs to one native run. Identical delivery/reconciliation reuses it;
changed content or lineage fails. The existing node-private native journal retains the source result.
Signed progress frames remain content-free; bytes are a separate argument to the inert authenticated
result-ingestion component. Physical upload transport/runtime wiring is not activated by this block.

Only completed snapshots with a non-null result claim can deliver a result. Missing output is not an empty
file; a genuinely empty output has the hash and byte count of zero bytes. Validate strict UTF-8 and reject
known credential patterns before artifact storage. This is not comprehensive data-loss prevention.
Private text never enters audit/protocol logs, receipts or public evidence. Render as escaped text, never
HTML, scripts, commands, automatic links or tool instructions.

Storage writes happen before the SQL receipt; metadata is not accepted until exact readback verification.
A failed or uncertain operation never restarts native work. An interrupted write or SQL failure may leave
an unreferenced artifact for scoped retention/reconciliation; no automatic deletion or widened cleanup.
An exact result delivery can reconcile its deterministic artifact identity. This is artifact delivery,
not permission to resubmit a provider request. Missing/corrupt bytes are unavailable, not a verified result.
Each artifact I/O operation has a two-second logical ceiling and receives an abort signal. A timeout
quarantines that result-store instance; it cannot automatically repeat a pending write or accept a late
response. Actual I/O cessation is not inferred from a timer. A separately reconstructed storage instance
and exact retained identity are needed for reconciliation. The receipt records first request receipt time,
not a measured disk flush/SQL commit timestamp.

## Private result and review views

Reuse current task/project membership, grants and session revocation. Result content requires explicit
`tasks.results.read` in addition to task/project read; metadata alone is not permission to read bytes.
Serve bounded private JSON/text through the existing protected process, never a public file URL or
storage locator. No browser cache or persistent browser copy is introduced. Configuration absence stays
distinct from no recorded result; unavailable reads clear displayed content.

Read existing Completion Gate records under their existing HMAC and external rollback checkpoint. Add a
single consistent read for a task subject; do not initialize checkpoints, create acceptance profiles, record
reviews, change revisions or issue approvals as a side effect of a read. Preserve exact target/result digest
binding and separate quality review from execution approval. This block connects recorded review evidence;
owner review/revision commands remain the next integration, not simulated by local UI state.
The open file has a visible identity and fingerprint. Each review separately states whether both match
that open file; a match to another listed file is not a match to the displayed content. After complete
history verification/status calculation, the wire projection is capped at 524,288 UTF-8 JSON bytes by
omitting oldest whole review targets with an explicit flag. Retained status/evidence is unchanged, the
browser's one-MiB reader ceiling is not enlarged, and omitted history remains stored.

The private web role receives only the additional artifact/completion reads and a lock-only integrity
column privilege needed by existing verified review reads. It does not receive artifact/review writes or
canonical transitions. Schema/profile changes are explicit repository migrations, never startup setup.
The web service captures only artifact-read and checkpoint-read functions; artifact writes and checkpoint
initialization/advancement are unavailable even if composition supplied a fuller storage object.

## Verification and remaining gates

Use actual disposable SQL, existing signed protocol authentication, native journal snapshots, artifact
storage adapters, current web sessions and compiled routes in integration tests. Cover exact byte recovery,
missing/corrupt storage, empty/oversize/non-UTF-8/credential-like content, scope/revocation, unknown configuration,
rollback-protected review evidence, readable escaped UI and original canonical lifecycle remaining unchanged.
Obtain independent review before publication and retain any negative findings and repairs.

No listener, real PostgreSQL, live credentials, provider/agent, physical upload, browser, deployment or merge.
Dedicated production storage/retention and transport, owner review commands, bounded executable planning/
admission/dispatch, real host qualification and the complete private-beta journey remain outstanding.
