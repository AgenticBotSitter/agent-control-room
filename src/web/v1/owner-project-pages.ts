/** Shared owner project shells. Each host keeps its existing authorization and
 * query rules; optional modules and host-only top-level pages stay separate. */
export const ownerProjectSectionsV1 = Object.freeze([
  "inbox", "agents", "reviews", "activity", "files", "settings",
  "automations", "improvements", "coordination",
] as const);

export const ownerProjectSectionPageV1 = new RegExp(
  `^/projects/([^/]+)/(${ownerProjectSectionsV1.join("|")})$`,
);
