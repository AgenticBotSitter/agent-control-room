# Private installed owner-host preflight

**Status:** shipped, inert source boundary. It does not install or start Control
Room.

The extracted release now includes one fixed command that answers the first
owner-host setup question without asking for a path, password, command,
environment variable, callback, or standard-input payload:

```sh
node scripts/preflight-private-local-owner-host.mjs
```

The command verifies the exact prepared release, loads only the release-bound
Control Room entry, creates the callback-free one-use owner-host provider, and
prints the first concrete missing boundary **and** the complete ordered list
of remaining prerequisites. That gives the owner one setup bundle rather than
a sequence of surprise prompts. It does not read private paths or credentials,
open the installation journal or PostgreSQL, start a service or worker, or
invoke Hermes or Claude.

At the current source checkpoint its expected result is
`installed_configuration_custody_input_missing`. That is a real product gap,
not a request for the owner to type another terminal command. The installed
owner-host composition still needs the owner-selected protected installation
and data locations plus the production stage adapters for database authority,
protected data, first owner, recovery, platform service, agent readiness, and
final review. Those cannot be truthfully invented by a launcher or discovered
from environment variables.

The existing reviewed adapters are retained beneath that future composition:
the PostgreSQL production boundary, protected-root owner adapter, first-owner
ceremony adapter, recovery runner, macOS service adapter, Hermes admission
runner, final review, installed configuration custody, and held installation
journal. The provider does not add a second installer, database, scheduler,
permission system, or generic command runner.

Once the fixed owner-host composition is complete, the same shipped operator
will consume its process-local provider and run `status`, one `setup-next`
stage, or `start`. The owner-facing launcher can then expose one reviewed setup
flow while retaining separate confirmation at genuinely consequential effect
boundaries. Until then, preflight remains read-only and fail-closed.
