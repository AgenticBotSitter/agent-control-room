# E54 — owner signer reuse candidate

2026-09-06. Read-only upstream source research; no dependency adoption or credential access.

## Named gap

E53 produces canonical unsigned approval bodies. A separately controlled owner signer
must sign those exact bytes without lending its private key to Control Room's web server
or its workers. Existing node key stores have node-identity references and unlock state;
their presence does not establish separate owner custody or transaction consent.

## Candidate: ssh2 agent interface

The [ssh2 agent implementation](https://github.com/mscdex/ssh2/blob/master/lib/agent.js)
has an OpenSSHAgent signing method accepting a public key and data, with an existing
agent protocol implementation. This is a candidate for reusing an agent-held dedicated
owner Ed25519 key rather than writing a socket protocol or private-key store. Its
[license](https://github.com/mscdex/ssh2/blob/master/LICENSE) is MIT. The inspected
[manifest](https://github.com/mscdex/ssh2/blob/master/package.json) reports 1.17.0,
an install script and optional native dependencies; an evaluation must disable lifecycle
scripts and review the resolved dependency/license closure. Do not import the general
SSH client/server capabilities into the website just to obtain signatures.

This source inspection used moving master URLs. It is not an immutable acquisition,
proof of the current registry release, maintenance/security audit or compatibility test.
Before adoption, capture an exact release/integrity and verify that package's source.
No package or source file was downloaded into the workspace in this block.

## Important limits

[OpenSSH documents confirmation-required identities](https://man.openbsd.org/ssh-add.1)
and ssh-askpass confirmation. That does not establish a Control Room transaction-review
UI, nor does it prove the installed Mac's implementation or a password manager behaves
identically. A successful signature cannot by itself prove that the owner reviewed the
specific project/task. Agent access must never be treated as user attendance.

A dedicated owner key is required; do not reuse an SSH login key or a node/server key.
Never discover/use ambient SSH_AUTH_SOCK, enumerate existing identities, forward an
agent to the VPS, or load a key as part of source-only evaluation. Endpoint selection,
public-key pin matching and key separation are trusted local setup responsibilities.
The candidate must prove the returned signature is the raw Ed25519 form accepted by
the existing packet verifier; do not confuse it with an SSHSIG file wrapper.

## Next bounded evaluation

1. Check free disk space and record an isolated download root before acquiring a pinned
   candidate package. Keep all files/cache and license records in the existing ledger.
2. Use the package's protocol implementation with an in-memory fake agent and generated
   disposable keys only. No sockets, SSH process, listener, password manager or Keychain.
3. Pass E53's canonical bytes through that implementation, verify with the existing
   Ed25519 verifier and submit a synthetic packet through canonical approval intake.
4. Test wrong key, malformed/partial response, failure and outstanding request handling.
   If cancellation cannot stop the underlying operation, retain uncertainty explicitly;
   never automatically sign again after an ambiguous result.
5. Decide on adoption only after this compatibility evidence. Keep local consent,
   trusted prepared-request handoff and safe handling of both approval signatures as
   separate integration work, not promises supplied by the library.

This is a candidate for custody access, not a new agent-to-agent transport or fleet queue.
Unattended low-risk work still requires an explicit bounded policy design; a generic
confirmation prompt for every signature would not satisfy the owner's no-babysitting goal.
No choice of real credential provider or standing service is made here.
