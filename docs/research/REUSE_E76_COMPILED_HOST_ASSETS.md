# E76 — actual compiled task page and browser assets through host

2026-09-06. Verification only; no network listener, credentials or deployment.

The task-host test previously used synthetic empty assets, while the separate serving
test exercised real browser files. The combined task-host test now loads the actual
compiled `dist-vps/client` with the existing restricted asset loader, creates/plans/
assigns a task, and requests its page through the server's installed request listener.
Every referenced JavaScript/CSS asset is then requested through that same listener,
requiring status 200 and nonempty content. Existing private bind, logout and cleanup
checks remain. No replacement asset loader or HTTP server was written.

The test server is an EventEmitter and exchanges are in-memory Node streams. This
does not verify browser hydration, visual layout, physical networking or a real agent.
The initial test assumed createServer received a callback; source inspection showed
the host installs its `request` listener separately. The corrected test emits that
actual event. Initial run: seven pass, one fail; corrected focused run: eight pass.
Targeted lint passes. No application source changed and no rebuild was required.
Final full compiled regression run: 41 pass, zero failures/cancellations/skips.

The host audit also confirms that compiled factories are not an operator executable:
trusted configuration/resource provisioning and supervised process lifecycle remain
unfinished. Existing renderer, asset loader, task-host lifecycle and installed queue
should be composed rather than replaced. E75's placement decision was requested from
the owner asynchronously; absence of that answer does not stop other local work.
