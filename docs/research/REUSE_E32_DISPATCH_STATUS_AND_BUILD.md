# E32 — truthful submission status and compiled application

2026-09-06. Local implementation/build/tests only.

Task list/detail HTTP projections now report dispatch `configured` only when trusted
composition supplies the submission port. The SQL service retains its unconnected
default; browser input cannot select the flag. The task detail explains that configuration
and a recorded submission do not prove an online worker or observed execution.
Actual-package startup tests check both list/detail values; the queue-free application
test checks `not_connected`.

An overlapping-click test proves one POST, with an unrelated task read unable to clear
the original pending submission. The new standalone submission-client suite is included
in the package's default test lifecycle through posttest. No dependency or lockfile change.

The production build uncovered a genuine packaging failure: the bundler interpreted the
local `require("tasks.read", ...)` permission helper in NativeQueueAuthority as a module
import. Renamed only that local binding to requirePermission, preserving the WebActor
require property and all policy/precommit checks. No dependency externalization or
authorization relaxation was used. The subsequent complete five-stage VPS build passed.

Evidence:
- Eight actual-package startup checks pass with configured task projections/readback.
- Queue-free approval/source tests pass (five approval checks).
- Thirteen approval/submission browser-client/static-render checks pass.
- Fifteen native queue authority tests pass after the helper rename.
- Three compiled application/approval checks pass, including exclusion of server
  cryptography and approval trust from browser assets.
- Typecheck, targeted lint and whitespace checks pass.

Build warnings about middleware naming and ineffective dynamic imports remain nonfatal.
Generated dist-vps is local ignored build output, not deployed or downloaded. No listener,
provider, credential operation, PostgreSQL server or GitHub write was performed.

Next: real browser interaction coverage and full configured host/worker composition.
Compiled tests here exercise the existing approval/assignment composition, not a compiled
actual-package queue journey. Physical PostgreSQL pool isolation, complete upstream schema
acceptance and live-owner/agent acceptance remain open. Do not count this as a live system.
