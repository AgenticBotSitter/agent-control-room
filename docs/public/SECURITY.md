# Public candidate security boundary

## Default private

Only explicitly classified regular files under the frozen public roots can become release inputs. Path placement alone never grants eligibility. Unclassified content remains private.

## No sensitive or production values

Public candidates must contain no access material, internal host identity, private locators, production history, artifact bodies, owner trust records, runtime state, or internal review findings. Synthetic examples use fixed fabricated identities.

## No effects

The current package implementation imports no package installer, archive builder, signer, uploader, publisher, native harness, provider, filesystem, process, or network client. A green local check cannot grant any of these powers.

The adapter SDK invokes adapter functions supplied by its caller. JavaScript function shapes cannot prove that caller-supplied code is effect-free. The conformance kit is therefore not a sandbox: untrusted third-party adapter code requires separate OS/process isolation with no credentials, private files, provider access, or network authority.

Public data accepted by the SDK is copied through bounded ordinary-data checks. Proxies, accessors, symbols, sparse arrays, custom prototypes, cycles, non-finite numbers, and oversized structures fail before property behavior can run.

## Evidence language

Use “local source candidate” for this phase. Synthetic reproduction may create only a synthetic candidate. Clean-room installation, signature verification, public safety, certification, and publication require later independent evidence and owner decisions.

## Reporting

No public vulnerability-reporting destination is configured in this phase. Do not place a private address or account identifier into these files. The reporting policy and protected channel remain an owner-controlled CR10Q decision.
