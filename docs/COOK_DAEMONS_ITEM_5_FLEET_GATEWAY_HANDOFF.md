# cook/daemons item 5: Mac-local fleet gateway service hand-off

`cook/connonly` starts and owns the loopback fleet gateway in the direct
development/preview lifecycle: `mac:up`, `mac:down`, and `mac:status` track the
exact gateway command, PID, log, and port independently from the task host.

The production launchd definition remains owned by `cook/daemons` item 5. That
item must add a separate service for:

`node scripts/mac-local/start-fleet-gateway.mjs --owner-attended --protected-root <absolute-root>`

It must preserve the separate-process boundary, restart after an unexpected
exit, stop before or with `mac:down`, expose its state through service status,
and never put database credentials in arguments, environment variables, logs,
or plist content. Until that definition lands, service-mode `mac:up` prints an
explicit pending hand-off and `mac:status` refuses to call the whole stack
healthy when the gateway is absent.
