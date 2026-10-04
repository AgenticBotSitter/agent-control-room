import assert from "node:assert/strict";
import test from "node:test";
import { fixture, now, request, trust } from "./helpers/web-foundation";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { WebProjectService, projectConfigurationDigestFor } from "../src/web/v1/project-service";
import { WebNewsService } from "../src/web/v1/news-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { parseProductConfigurationV1, PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";
import { buildNewsStoryV1 } from "../src/project-adapters/news/v1/story";
import { buildNewsWorkOrderProposalV1 } from "../src/project-adapters/news/v1/proposal";
import { sha256Digest } from "../src/security";
import { projectModuleVisible } from "../private-app/app/project-navigation";

const key = new Uint8Array(32).fill(3);
const configuration = parseProductConfigurationV1({ schema: PRODUCT_CONFIGURATION_SCHEMA_V1, displayName: "Test", defaultTimezone: "UTC",
  modules: { ideaLab: false, news: true, sessionObservations: false },
  limits: { maxProjects: 10, maxTasksPerProject: 10, maxResultsPerTask: 10, maxArticleSources: 5, maxIdeaParticipants: 0 },
  projectTemplates: [{ id: "core", displayName: "Core", enabledModules: [] }] });

test("news stays hidden and its server actions are refused for a project without the news module", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const projects = new WebProjectService(f.client, scope, () => now, undefined, undefined, configuration);
  const created = await projects.create(identity, { title: "Core project", summary: "No news module", templateSelection: {
    templateId: "core", configurationDigest: projectConfigurationDigestFor(configuration) } }, "news-module-gate-create");
  const project = created.project;
  assert.equal(projectModuleVisible("news", true, project.presentation), false);
  assert.equal(projectModuleVisible("news", false, undefined), false);

  const story = buildNewsStoryV1({ ...scope, projectId: project.projectId, storyId: "story:news-module-gate", clusterId: "cluster:news-module-gate",
    queue: "important_now", title: "Unreachable source", summary: "Must not create work.", canonicalUrl: "https://example.invalid/news-module-gate",
    sourceLabel: "Fixture", publishedAt: new Date(now).toISOString(), discoveredAt: new Date(now).toISOString(), lastVerifiedAt: new Date(now).toISOString(),
    verificationState: "review_only", priorityScore: 50, coverageCount: 1, contentDigest: sha256Digest("module-gate-content"),
    sourceEvidence: [{ evidenceId: "evidence:news-module-gate", sourceId: "source:news-module-gate", sourceKind: "rss", sourceLabel: "Fixture",
      canonicalUrl: "https://example.invalid/news-module-gate", observedAt: new Date(now).toISOString(), evidenceDigest: sha256Digest("module-gate-evidence"),
      containsRawNewsletterBody: false, grantsNetworkAuthority: false }] });
  const proposal = buildNewsWorkOrderProposalV1({ ...scope, projectId: project.projectId, proposalId: "proposal:news-module-gate", story,
    actionId: "research_brief", requestedTitle: story.title, goal: "Verify this before acting.", requestedPlatform: "any",
    requestedByActorDigest: sha256Digest("module-gate-owner"), requestedAt: new Date(now).toISOString() });
  const news = new WebNewsService(f.client, scope, { integrityKey: key, productConfiguration: configuration }, () => now);
  await assert.rejects(news.list(identity, project.projectId), error => error instanceof WebAccessError && error.code === "not_found");
  const tasks = new WebTaskService(f.client, scope, () => now, { newsIntegrityKey: key, productConfiguration: configuration });
  await assert.rejects(tasks.proposeNewsResearch(identity, project.projectId, proposal, "news-module-gate-save"),
    error => error instanceof WebAccessError && error.code === "not_found");
  assert.equal((await tasks.list(identity, project.projectId)).tasks.length, 0, "a hidden module cannot create a task");
});
