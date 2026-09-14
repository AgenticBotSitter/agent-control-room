# Project templates and per-project presentation

This document explains how an authorized user chooses a configured template while
creating a project, how that selection survives reload and restart, and how the
project page shows the selected optional modules and their actual availability.

## Data shape

`payload.presentation` is added to the existing `projects.payload` JSON object.
No database migration, new grant, or parallel project registry is needed. Other
fields (`projectKind`, `origin`, `createdAt`, ...) are preserved.

```jsonc
{
  "schema": "control-room.project-presentation/v1",
  "templateId": "news-focused",
  "configurationDigest": "sha256:<64-hex>",
  "templateDisplayName": "News focused",
  "enabledModules": ["news"]
}
```

* `templateId` and `templateDisplayName` come from the trusted configuration,
  not the request body.
* `configurationDigest` is `sha256Digest(parseProductConfigurationV1(trustedConfiguration))`
  using the existing canonical digest implementation.
* `enabledModules` is captured in the canonical order
  (`PRODUCT_CONFIGURATION_MODULES_V1 = ["ideaLab", "news", "sessionObservations"]`).
  Duplicate or unknown modules are rejected at insert time.

## Create-time contract

The create endpoint accepts:

```json
{
  "title": "News project",
  "summary": "What the project is for",
  "templateSelection": { "templateId": "news-focused", "configurationDigest": "sha256:<64-hex>" }
}
```

`templateSelection` is the only browser-supplied template data. The browser never
supplies module lists or display names.

The server validates:

* `templateSelection.configurationDigest` matches the digest the server captured
  at startup. Stale digests reject with `invalid_request`.
* `templateId` exists in the trusted configuration. Unknown templates reject
  with `invalid_request`.
* Every module the template enables is currently globally enabled. Templates
  that enable disabled modules reject with `invalid_request`.
* The trusted configuration itself must be present. No request can enable a
  worker, connector, listener, result return, or external effect by guessing
  a configuration.

The successful create stores the captured snapshot in `payload.presentation`
immutably. The same selection re-submitted with the same idempotency key
returns the original receipt, even after the configuration has changed.

## Read-time contract

The catalog, single-project, and create response all carry an `effectivePresentation`:

```jsonc
{
  "schema": "control-room.project-presentation/v1",
  "templateId": "news-focused",
  "templateDisplayName": "News focused",
  "displayName": "News focused",
  "enabledModules": ["news"],
  "availableModules": ["news"],
  "templateRemoved": false,
  "source": "saved"
}
```

* `source: "saved"` carries the historical snapshot exactly. The receipt
  preserves the template id, display name, and enabled modules as they were
  when the project was created.
* `source: "legacy_global"` is returned for projects created before templates
  were available. They expose the current globally enabled modules as their
  effective availability.
* `availableModules` is the intersection of `enabledModules` with the currently
  globally enabled modules. A module that the operator has globally disabled
  is reported as unavailable, never silently re-enabled.
* `templateRemoved` is true when the saved template is no longer in the
  operator configuration. Core pages remain available; saved template modules
  appear unavailable until the operator restores the template.
* The historical `configurationDigest` is **not** echoed to the wire. Clients
  that need it for a subsequent update can read it from the trusted
  `/api/v1/product-configuration` response and re-derive it deterministically.
* Old receipt parsers must accept omitted `presentation` for legacy projects.

## Presentation is not authorization

Template selection changes the UI surface, not the server's authorization
model. Hiding a tab in the navigation does not revoke or grant a permission;
existing server permissions remain authoritative on direct URLs and APIs.

## Failure modes that fail visibly, never permissively

* Unknown template id → `invalid_request`.
* Stale digest → `invalid_request`.
* Template module that is not currently enabled globally → `invalid_request`.
* Malformed stored presentation (wrong schema, duplicate modules, wrong order,
  missing field) → the read fails visibly. The service never falls back to a
  permissive legacy default when stored presentation is corrupt.
* Same idempotency key, different request → `conflict`; the original receipt
  is preserved.

## Restart and replay

* Restart preserves the saved snapshot. Service reconstruction reads the
  `payload.presentation` JSON the same way as the original insert.
* The browser may compute the digest for a subsequent create by reading
  `/api/v1/product-configuration` and applying the same canonical digest. The
  server and client agree because the canonicalization is deterministic.
* Historical receipts are immutable in this package. Removing a template does
  not rewrite old projects. Effective presentation is always the saved
  snapshot intersected with the running global modules.

## Browser journey

The create form renders a template picker only when the trusted configuration
exposes at least one template. The picker offers "No template (use global
modules)" plus one option per configured template. The form sends the selected
template id and the digest it computed from the trusted configuration. The
server derives the saved snapshot, including display name and enabled modules,
from the trusted configuration; the browser never supplies those fields.

The project page navigation hides tabs for saved modules that are not currently
globally enabled. A removed template renders an "unavailable-template"
explanation but keeps core pages (overview, inbox, files, settings) accessible.
