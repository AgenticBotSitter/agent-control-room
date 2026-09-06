# Trusted native evidence receiver ownership

Root-owned implementation contract, 2026-09-05; base PR #337 at `6dac246`.

The optional private task bootstrap verifies a fourth fixed database role on the same
private PostgreSQL primary before installing the application. It owns no additional
primary, listener, enrollment, credential, server signer or native agent. Existing
web/coordinator/result profiles stay unchanged. Absent configuration stays inert.

Internal `evidence.register` accepts only project/job/attempt/input identity. It reads
authenticated stored delivery envelope, transmission intent and recorded node receipt;
matches their identities and derives the discovered run with locally pinned enrollment.
It never accepts a caller-authored run, prompt, deadline, signature or authority. The
authenticated node intake time is the initial observation timestamp: server receipt
arrival may occur after valid native progress. Fresh creation is deadline-fenced through
precommit; exact existing registration can reconcile historical records. Run creation
is intake evidence, not proof that node admission passed or execution started.

After durable run registration, the existing result writer registers the actual saved
execution-plan review binding. `evidence.receive` uses the existing recorded-delivery
ServerNodeSession authentication and currentness gate. Review binding precedes progress;
progress precedes optional completed-byte capture; capture precedes review submission;
session acknowledgement follows the full requested operation. No new wire format or
double authentication/replay consumption is introduced.

Registration, review binding, signed progress, storage I/O, metadata, submission and
acknowledgement are separate durability boundaries. A later failure does not erase
earlier evidence or authorize re-execution. No implicit retry, polling or scheduling is
added. Exact replay uses existing stores; capture may repeat a content-addressed put.
Timed-out storage remains uncertain on the owned result store. Failed metadata may leave
stored bytes without metadata; cleanup/deletion is not authorized or invented.

Capture copies inputs and checks session/runtime/clock/cancellation before and after
storage I/O, at database precommit and after acknowledgement. SQL operations use the
existing bounded pools; the shared coordinator admission/drain owns all optional pools
and invalidates retained handles on failure/close. Output is narrow run/result receipt
metadata, not prompts, raw bytes, keys, private database configuration or approvals.

Migration0056 adds inert attempt/lease lock columns only. The fixed native-evidence role
reads canonical run bindings and authenticated delivery history, writes run/event evidence,
captures artifact metadata and appends audit. It has no canonical job/attempt/lease state
update, queue/delivery write, replay-authentication store write or Completion Gate access.
The existing result writer alone owns target/revision submission; owner quality remains
separate. The receiver depends on a supplied authenticated ServerNodeSession; session
creation, authentication-store ownership and real transport lifecycle remain unconfigured.

Independent evidence must cover actual restricted registration/progress/capture, exact
byte readback and submission, wrong scope/identity/content refusal, permission denials,
uncertain acknowledgements, shutdown and absent-option behavior. Fake transport and
privileged fixture delivery setup must remain explicitly labelled. No provider/native
call, physical PostgreSQL, service start, credential operation, deployment or merge is
authorized by this repository block.
