# CR14C private approval interface and startup

The existing private Task page gains an execution-approval panel. It can review unsigned task content,
model/provider, machine and reservation deadline; choose an already-signed JSON approval file; save the
paired permission without starting work; and read the historical receipt after uncertainty. It does not
ask for code, credentials or private keys. The panel explicitly says secure owner signing is not connected.
This file exchange is an intake capability, not completion of the eventual integrated signing workflow.

Owner signing remains separate from online server signing. The app does not sign from a login session,
generate owner keys, install pins or claim human presence from an online assertion. Actual custody/signing
and physical host qualification remain separately gated. No task dispatch is enabled by saving permission.

The shared protected task handler mounts `/approval`: GET accepts exactly one expected-input digest and
returns a checked historical receipt; POST `prepare` returns an allowlisted unsigned review projection;
POST `store` accepts the strict paired packet and expected input digest. Request JSON is capped at32KiB,
and reply scope/flags/digests are checked before emission. Shared edge authentication, URL/origin and
cross-site protections, session revocation and coordinator owner authorization all remain required.
Responses are no-store/noindex with no redirect or native locator/credential/profile-key exposure.

An explicit optional startup configuration snapshots enrollment before opening either pool. Both existing
role/schema gates run before installation. The combined application supplies only bound narrow approval
operations to the private web process; its SQL role cannot read approval packets. No browser field can
supply runtime enrollment or owner trust. Supplied public trust stores remain separately owned.

The browser keeps only transient selected file text and bounded pending digest metadata. File text is
limited to24KiB and discarded after save/uncertainty. Canonical SHA-256 via browser WebCrypto must match
the server packet digest. Uncertain writes cannot be resubmitted through that client until exact receipt
readback resolves them; no automatic POST retry exists. Confirmed historical receipts survive older
empty reads only after successful current-authorized GET, and conflicting immutable receipt digests fail.
Data/actions hide when refreshed task detail or approval access is unavailable. Late request and file
selection results cannot replace current task data. No browser storage or server key material is added.

Verification uses disposable databases, synthetic signatures, injected request transport and compiled
in-process handlers. No physical listener, native/provider call, credentials, deployment or merge. The
background goal does not open a browser preview; no browser-click or live-pilot evidence is claimed.
