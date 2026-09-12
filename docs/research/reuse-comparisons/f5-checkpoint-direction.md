# Independent checkpoint implementation direction

2026-09-08. Conditional target choice, not full RC5 comparison or deployment
acceptance. Retain one etcd checkpoint using the existing actual CR adapter.
Do not add a second checkpoint service or move transactional state out of PostgreSQL.

The existing adapter performs exact scope/value/create/modification-revision/lease
checks and classifies uncertain replies. Nine independently reviewed observations
cross the real service with the actual adapter. This is concrete existing reuse,
not a new consensus implementation. Retain canonical completion SQL and signatures.

OpenBao2.6.2 remains a credible alternative: actual service tests show scoped
read/update CAS and denied deletion/recreation. However its data-version timestamp
is not stable key identity; metadata reads plus numeric CAS do not automatically
reproduce the current adapter's atomic identity/value comparisons. A distinct,
reviewed mapping is necessary. No assertion that OpenBao cannot support another
acceptable design, is slower, or failed its unperformed adapter/restore tests.

Etcd's runtime READWRITE credential **can delete** the key. The adapter detects
missing/replaced head and refuses reinitialization; that is not deletion prevention
or protection against coordinated compromise of all trust domains. Keep the owner-
controlled anchor, trusted pins and recovery custody outside the protected database
deletion/rollback domain. Do not advertise a locally co-restored database and anchor
as independent integrity. A missing head remains an outage requiring owner recovery.

Use the existing adapter to avoid replacing a tested interface absent a demonstrated
required benefit. This is not a measured resource/cost winner or authorization to
relax the threat model. In-memory checkpoints remain test-only. A custom proxy that
merely hides etcd's delete API is not selected or a claimed new security boundary.

## Implementation and reopening gates

Complete authenticated bounded transport, pinned instance provisioning, actual
canonical payload/concurrent CAS, lost acknowledgement, supported restore and
SQL/anchor split-commit recovery. Retain explicit owner recovery; no automatic
initialization, rollback guess, retry of uncertain writes or stale-store fallback.
Complete exact release/license/advisory review before installation. Existing local
etcd3.7.1 evidence is not a blanket production release recommendation.

The unperformed equivalent OpenBao adapter and supported restore comparisons remain
open evidence, not falsely passed by choosing etcd. Reopen if a required acceptance
case fails, deployment cannot provide independent custody, the agreed threat model
requires server-enforced deletion denial, or an OpenBao mapping demonstrates a
material required advantage. No new service, identity, permission or production
change follows from this document.

Evidence: f5-etcd-adapter-fit.md / review, f5-openbao-service-fit.md,
f5-openbao-identity-map.md / review; CR8B_COMPLETION_GATE_CONTRACT.md persistence
and integrity requirements. Exact measurements and limitations remain in receipts.
Independent compare_ui challenge accepted the conditional direction without treating
independence as proven. Root accepted that condition in DR-15. Full comparison and
all stated acceptance gates remain open.
