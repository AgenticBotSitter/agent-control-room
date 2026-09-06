# E55 — pinned ssh2 offline signing evaluation

2026-09-06. ssh2 1.17.0, exact isolated acquisition and licenses in REUSE_DOWNLOAD_LOG.md.
No production adoption, sockets, SSH daemon/agent, credential store or provider call.

## Evidence

The pinned package's AgentProtocol client and server communicate entirely through Node
streams. Replies are fragmented into three-byte chunks. Only synthetic fixture keys
are used. E53 approval/recovery material goes through upstream signing request/response
framing, existing Control Room Ed25519 verification, and the actual canonical approval
intake/store. One packet is stored without starting work. The evaluation verifies the
package version and inspected agent.js hash before loading it.

The successful pair returns raw Ed25519 signatures, not SSHSIG wrapper files. Corrupt
bytes and signatures from a different generated key fail the existing verifier even
when protocol transport succeeds. Agent denial does not cause a retry. Destroying a
request before any reply calls it back with failure, not a signature.

## Negative finding retained

The first malformed-response check was cancelled by Node because its signing callback
never resolved and the event loop emptied. A second check waiting for an error event
also cancelled. The final diagnostic observes the exact behavior: a stream-write error
is returned and close is emitted, but no error event or signing callback occurs after
the pending request is consumed. The package's destroy hook drops the error argument.
Each of the two unsuccessful three-test runs had two passes and one cancellation;
retain both findings rather than presenting the original runs as green.

Consequently a production wrapper cannot await only sign's callback. It must settle an
outer operation from protocol closure as well as errors/callbacks, bound the whole
lifetime, dispose its owned channel and preserve uncertainty without another signature
attempt. The inspected source also strips the algorithm label; exact pinned-key
cryptographic verification remains mandatory. These are adapter requirements, not an
excuse to fork/rewrite the upstream protocol.

## Decision and remaining scope

Final diagnostic run: three tests passed, no failures/cancellations/skips; targeted
lint passed. Passing the negative diagnostic proves the limitation, not its remediation.

Compatibility is promising enough to continue an offline bounded-adapter experiment,
not to add the dependency to the app or activate a real SSH agent. The current test
imports the protocol module directly to avoid loading unrelated SSH client/server code;
the package index also exports AgentProtocol. Real OpenSSHAgent socket behavior,
platform integration, cancellation after a real signing request, owner task review,
private-key custody/provisioning, pin separation and trusted preparation remain unproved.

Exact command (requires retained evaluation dependencies):

```sh
CR_SIGNER_EVAL_ROOT=/private/tmp/cr-e55.x7lWXA node --import tsx --test scripts/research/ssh-agent-signing-evaluation.test.mjs
```

This opt-in experiment is intentionally absent from default CI: it requires an isolated
download root and is not an installed application dependency. No permission to touch
ambient SSH_AUTH_SOCK or existing identities follows from these results.
