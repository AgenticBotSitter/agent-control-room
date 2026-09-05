# Durable signed native envelope staging

The trusted coordinator reserves one server-session sequence and signs the original HMAC-verified
delivery body inside the current canonical approval transaction. The saved owner packet is reverified;
active project/job/attempt/lease/node identity and key validity are checked under the existing locks.
The negotiated session node/key must match that canonical node. Frame expiry is no later than the
session, task or canonical node key deadline. Server signer output must match the exact original frame
and verify under the session's separately configured server public key.

Migration0050 stores one immutable envelope per tenant/job/attempt with a unique tenant/message ID,
foreign keys to the job/project and original prepared delivery, and a domain-separated HMAC. It adds
coordinator SELECT/INSERT only; the web role cannot read or write the frame. The node key, exact frame,
staging actor/time and audit are committed together. Schema preparation requires migrations0001–0050,
136 tables and verified digest `797e11e174de3dbac425f714d2f2c4a405b24b4fce8c39982b4d15a72250b758`.

Current signature/trust/cancel/channel/deadline checks fence commit. A stored envelope refuses a second
signature even on a replacement connection. An uncertain commit closes the session and returns no
success; authenticated historical readback exposes only scoped receipt metadata, including after expiry.
Historical evidence is neither permission to transmit nor proof that transmission occurred.

After staging, the session is prepared, not generally ready: its reserved sequence cannot be reused or
skipped by later control traffic. This block intentionally has no native transmission method, callback,
HTTP/lifecycle mounting or automatic retry. Durable transmission-attempt and authenticated receipt
integration must follow before activating a runtime. A stored frame may have been committed even if
the final acknowledgement was lost; never reconstruct, re-sign or send it based solely on that loss.

The signer and transaction callback are trusted process composition, not caller-provided web inputs.
Only the coordinator-backed path establishes canonical provenance; generic supplied callbacks do not.
Server key custody/rotation, ongoing session renewal, owner signing and node admission remain separately
required. No credentials, native/provider calls, listener, database service or deployment is configured.
