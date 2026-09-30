import { MODULE_MANIFEST_SCHEMA_V1, parseModuleManifestV1, type ModuleManifestV1 } from "./manifest";

const emptySettings = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const manifests: readonly unknown[] = [
  {
    schema: MODULE_MANIFEST_SCHEMA_V1,
    id: "ideaLab",
    version: "1.0.0",
    name: "Idea Lab",
    publisher: "Control Room Project",
    license: "Apache-2.0",
    controlRoomCompatibility: "^0.1.0",
    class: "code",
    permissions: {
      projectData: [
        { resource: "control_idea_sessions", access: ["read", "write"] },
        { resource: "control_idea_contributions", access: ["read", "write"] },
        { resource: "control_idea_syntheses", access: ["read", "write"] },
        { resource: "control_idea_decisions", access: ["read", "write"] },
        { resource: "control_idea_owner_authorizations", access: ["read", "write"] },
        { resource: "control_idea_bot_run_events", access: ["read", "write"] },
        { resource: "control_idea_live_authority_events", access: ["read", "write"] },
        { resource: "control_idea_qualification_spend_events", access: ["read", "write"] },
        { resource: "control_idea_canonical_task_sessions", access: ["read", "write"] },
        { resource: "control_idea_canonical_task_links", access: ["read", "write"] },
        { resource: "control_idea_promotion_task_links", access: ["read", "write"] },
      ],
      taskTemplates: ["idea.panel-participant", "idea.synthesis"],
      pipelineTemplates: ["idea.panel"],
      workerCapabilities: ["text.reasoning"],
      notifications: { slots: ["project.idea-updates"], maxPerHour: 20 },
      attention: { slots: ["needs-you.idea-decision"], maxOpenPerProject: 10 },
      scheduledJobs: { jobs: [], maxConcurrent: 0, maxRunsPerDay: 0, maxRuntimeSeconds: 0 },
    },
    ui: {
      projectTabs: [{ id: "idea.lab", label: "Idea Lab" }],
      settings: emptySettings,
      navEntry: { id: "idea.lab", label: "Idea Lab" },
      needsYou: true,
    },
    events: { subscribe: ["project.created", "project.archived"], emitNotifications: true },
  },
  {
    schema: MODULE_MANIFEST_SCHEMA_V1,
    id: "news",
    version: "1.0.0",
    name: "News",
    publisher: "Control Room Project",
    license: "Apache-2.0",
    controlRoomCompatibility: "^0.1.0",
    class: "code",
    permissions: {
      projectData: [
        { resource: "control_news_story_versions", access: ["read", "write"] },
        { resource: "control_news_research_proposals", access: ["read", "write"] },
        { resource: "control_news_source_observations", access: ["read", "write"] },
        { resource: "control_news_discovery_baselines", access: ["read", "write"] },
        { resource: "control_news_feed_plans", access: ["read", "write"] },
        { resource: "control_news_source_settings", access: ["read", "write"] },
        { resource: "control_news_story_archives", access: ["read", "write"] },
        { resource: "control_news_article_details", access: ["read", "write"] },
        { resource: "control_news_task_proposal_links", access: ["read", "write"] },
      ],
      taskTemplates: ["news.research"],
      pipelineTemplates: ["news.source-research"],
      workerCapabilities: ["network.public-fetch", "text.extraction"],
      notifications: { slots: ["project.news-updates"], maxPerHour: 60 },
      attention: { slots: ["needs-you.news-proposal"], maxOpenPerProject: 25 },
      scheduledJobs: {
        jobs: ["news.feed-collection"],
        maxConcurrent: 2,
        maxRunsPerDay: 96,
        maxRuntimeSeconds: 900,
      },
    },
    ui: {
      projectTabs: [{ id: "news.stories", label: "News" }],
      settings: {
        type: "object",
        properties: {
          "refresh-minutes": {
            type: "integer",
            title: "Refresh interval in minutes",
            description: "Minimum interval between source collection proposals.",
            default: 60,
            minimum: 15,
            maximum: 1440,
          },
        },
        required: ["refresh-minutes"],
        additionalProperties: false,
      },
      navEntry: { id: "news.stories", label: "News" },
      needsYou: true,
    },
    events: { subscribe: ["project.created", "project.archived"], emitNotifications: true },
  },
  {
    schema: MODULE_MANIFEST_SCHEMA_V1,
    id: "sessionObservations",
    version: "1.0.0",
    name: "Session Observations",
    publisher: "Control Room Project",
    license: "Apache-2.0",
    controlRoomCompatibility: "^0.1.0",
    class: "code",
    permissions: {
      projectData: [],
      taskTemplates: [],
      pipelineTemplates: [],
      workerCapabilities: [],
      notifications: { slots: [], maxPerHour: 0 },
      attention: { slots: [], maxOpenPerProject: 0 },
      scheduledJobs: { jobs: [], maxConcurrent: 0, maxRunsPerDay: 0, maxRuntimeSeconds: 0 },
    },
    ui: {
      projectTabs: [{ id: "session.observations", label: "Observations" }],
      settings: emptySettings,
      navEntry: { id: "session.observations", label: "Observations" },
      needsYou: false,
    },
    events: { subscribe: ["project.created"], emitNotifications: false },
  },
];

const parsedManifests = manifests.map(parseModuleManifestV1);
const registryEntries = parsedManifests.map((manifest) => [manifest.id, manifest] as const);
if (new Set(registryEntries.map(([id]) => id)).size !== registryEntries.length) {
  throw new Error("module_registry_duplicate_id");
}

/** Canonical product order, now derived from registered manifests rather than a fixed enum. */
export const REGISTERED_MODULE_IDS_V1 = Object.freeze(
  parsedManifests.map((manifest) => manifest.id),
) as readonly ["ideaLab", "news", "sessionObservations"];

export const MODULE_REGISTRY_V1: Readonly<Record<string, Readonly<ModuleManifestV1>>> = Object.freeze(
  Object.fromEntries(registryEntries),
);

/** Exact lookup. A missing id or requested version fails closed. */
export function getRegisteredModuleManifestV1(id: string, version?: string): Readonly<ModuleManifestV1> {
  const manifest = Object.hasOwn(MODULE_REGISTRY_V1, id) ? MODULE_REGISTRY_V1[id] : undefined;
  if (!manifest) throw new Error("module_registry_unknown_module");
  if (version !== undefined && manifest.version !== version) throw new Error("module_registry_version_unavailable");
  return manifest;
}
