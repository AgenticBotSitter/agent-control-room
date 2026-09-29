# Resumable installation plan

I2 is a pure, fixed-stage coordination record. It binds one reviewed topology
digest, one exact release digest, and one input digest per stage. It stores no
connection detail, credential, path, raw evidence, worker setting, or command.

The stages are release preflight, private placement, database authority,
protected data, first owner, recovery, platform service, agent readiness, and
final review. A stage is `not_started`, `running`, `passed`, `failed`, or
`uncertain`. Only a digest may accompany a terminal outcome.

On restart, a `running` or `uncertain` stage requires inspection; it never
authorizes a repeat effect. A failed stage requires owner attention. An exact
same action is replay-safe only when it matches the original expected revision
and the immediately recorded transition; old, future, or changed replays are
refused.

Changing the release or topology invalidates all proof. Changing one stage
input retains only earlier stages and invalidates that stage plus every later
dependent stage. A refresh that would erase `running` or `uncertain` work is
refused until that work is inspected and resolved. This package records no
authority to create a database, start a service or worker, or enable a route.
