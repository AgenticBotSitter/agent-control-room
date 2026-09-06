# E48 — explicit separate-project browser tabs

2026-09-06. Local UI change; no live browser acceptance.

The authorized project catalog now provides a separate, labeled Open in new tab link
for each project, including archived projects. Normal card navigation stays in the
current tab. Each new-tab link uses the encoded authoritative project ID, not its title,
and `noopener noreferrer`. No script opens windows; the browser controls presentation.
Links are not rendered when catalog data is loading or unavailable.

The project screen explains that closing a tab does not stop work, complete a project
or archive it. The project task instructions no longer assert that assignment is always
disconnected: task pages expose their configured services and recorded state. No claim
that a real fleet is running replaces the old statement.

Reuse decision: use the browser's existing tab lifecycle for this already requested
separate-page workflow. E04's Hermes Desktop active-session bar remains an evaluated
candidate for a future in-app strip, not adopted code. There is no new storage/cache,
cross-tab coordinator or Electron callback. Native links are sufficient for this change;
it does not claim to deliver an in-app open-project strip or live conversation catalog.
Normal project authorization still occurs independently in the destination page/API.

Nine focused catalog/browser-client checks pass, including duplicate titles with
different IDs, unavailable-data hiding, explicit new-tab labels and encoded navigation.
TypeScript and targeted lint pass. These are static markup/transport checks, not a
visual or keyboard interaction test. The cards use flex layout to keep the second link
within the existing card instead of letting two 100%-height anchors overflow it.
Production build and compiled regression results are recorded in BUILD_STATUS.md.

No downloads, copied upstream source, new dependency, command API, storage, GitHub,
credentials, service activation or deployment. The wider project/Idea Lab/ABS outcomes
remain in the completion plan; this only improves opening already authorized projects.
