# Security reporting

Unpublished draft. Do not publish this as an active reporting policy until a monitored
private contact or the repository's private vulnerability-reporting feature is configured
and tested. There is currently no public supported release announced by this draft.

## Report privately

Use the confirmed private reporting route listed in the released version of this file.
Do not put credentials, private project records or exploit details in public issues,
pull requests, discussions or agent job messages. Do not send production database dumps.

A useful report includes:

- The affected release/commit and component.
- The security boundary you believe can be crossed and its likely impact.
- A minimal reproduction using a system you own or are authorized to test.
- Synthetic inputs, expected versus observed behavior and sanitized supporting evidence.
- Whether you have disclosed the issue elsewhere and a safe way to contact you.

Do not test someone else's deployment or retrieve other users' data. This document
does not grant authorization to access third-party systems, promise a bounty or offer
legal safe harbor. Stop if testing would expose private information or cause harm.

## What maintainers do

Maintainers acknowledge and triage reports, investigate using disposable resources,
coordinate any necessary fix and agree on responsible disclosure where possible.
Response targets and supported versions must be published only when maintainers can
actually support them; this draft promises no response deadline.

A fix requires a regression test where practical and review of affected deployments
and releases. Publishing a patch does not automatically update a user's installation.
Security fixes must not conceal uncertainty, alter historical evidence or falsely label
a simulated check as proof that an operational deployment is safe.
