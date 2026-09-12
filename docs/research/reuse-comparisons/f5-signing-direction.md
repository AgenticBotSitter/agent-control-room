# Owner signing integration direction

2026-09-08. Conditional target selection, not established key custody or completed
platform comparison. Use a dedicated owner-controlled OpenSSH-agent-compatible
Ed25519 signing endpoint, accessed through maintained ssh2 protocol support and
the existing bounded signer, paired issuer and exact human-readable review.

Reuse E55–E58's executed synthetic protocol/issuer/intake evidence. Keep Node's
signature verification, canonical bytes, pinned owner public key, consent digest,
deadline and partial-packet refusal. Do not create custom cryptography, an SSH
protocol implementation or a new private-key vault inside Control Room.

The historical E55 acquisition directory was absent on this check; no dependencies
were redownloaded and no earlier test result is claimed as a fresh rerun. Read the
upstream v1.17.0 [agent implementation](https://github.com/mscdex/ssh2/blob/v1.17.0/lib/agent.js)
to verify the client boundary: OpenSSHAgent.sign obtains and destroys its own
stream; it exposes no cancellation handle in that method. Therefore do not claim
it plugs unchanged into E56's owned-channel closure contract. Connection/signing
lifetime integration is still a required bounded experiment; no socket was opened.

## Custody and alternatives

The owner endpoint and dedicated public-key pin are explicit configuration. Never
discover ambient SSH_AUTH_SOCK, enumerate personal keys, reuse an SSH login/node
key, forward an owner agent to workers/VPS, or store the private key in the web app.
A generic SSH confirmation is not proof of reviewing the exact Control Room task.
The actual trusted review/consent surface must bind the existing complete review.

Mac/Linux OpenSSH-compatible endpoint qualification is the initial target. Windows
pipe/account behavior is an explicit unqualified implementation responsibility—not
a claim that Unix socket results establish Windows custody. A platform password
manager or hardware-backed agent remains viable if it supplies the required exact
signing and consent contract. No comprehensive platform-product winner is claimed.
Secret-store APIs alone are not substituted for a non-exporting signer or consent.
Do not add OpenBao solely because it can store secrets, or infer hardware-backed
protection from the SSH protocol. Dedicated agent custody itself remains unproven.

## Acceptance and reopening

Exercise actual endpoint acquisition, wrong identity, permission denial, connection
deadline, close/cancel, malformed reply and delayed completion using disposable
keys first. Preserve E55's missing callback finding and E56's outer closure/deadline
handling. An ambiguous signing outcome must not trigger another signature attempt.
Verify explicit owner setup, exact review consent, key/pin separation and recovery
before activation. Real credentials and owner attendance require separate scope.

The ssh2 MIT protocol evidence does not clear all native/package/platform notices;
keep shipped imports and dependency closure explicit. No install or real signer is
selected for immediate activation. Reopen if owned lifetime/host isolation cannot
be met, or a tested platform signing provider materially improves custody with less
integration. The source/interface and native custody comparisons remain open; this
chooses a first implementation route without calling those missing tests complete.
