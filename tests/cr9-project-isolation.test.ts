import assert from "node:assert/strict";
import test from "node:test";
import {
  ABS_NEWS_PROJECT_ID_V1,
  ABS_NEWS_WORKSPACE_ID_V1,
  buildAbsNewsSyntheticWorkspaceV1,
  parseAbsNewsStoryV1,
} from "../src/project-adapters/abs-news/v1";
import {
  buildContentBloomsSyntheticFixtureRecordsV1,
  ContentBloomsContractErrorV1,
  parseContentBloomsOperationalRecordV1,
} from "../src/project-adapters/content-blooms/v1";
import {
  buildCurrentWayfarerDeliveryDisabledV1,
  buildCurrentWayfarerDeliveryReadinessDisabledV1,
  buildWayfarerSyntheticProjectPackV1,
  buildWayfarerWorkspaceViewV1,
  parseWayfarerDeliveryPreparationPackageV1,
  parseWayfarerProjectPackV1,
  parseWayfarerWorkspaceViewV1,
  WAYFARER_PROJECT_ID_V1,
  WAYFARER_WORKSPACE_ID_V1,
} from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function scopes() {
  const abs = buildAbsNewsSyntheticWorkspaceV1();
  const content = buildContentBloomsSyntheticFixtureRecordsV1();
  const wayfarer = buildWayfarerSyntheticProjectPackV1();
  return { abs, content, wayfarer };
}

test("CR9B-WF-130 ABS, Content Blooms, and Wayfarer retain three exact project scopes", () => {
  const { abs, content, wayfarer } = scopes();
  const values = [
    `${abs.workspace.tenantId}|${abs.workspace.workspaceId}|${abs.workspace.projectId}`,
    `${content[0]!.tenantId}|${content[0]!.workspaceId}|${content[0]!.projectId}`,
    `${wayfarer.tenantId}|${wayfarer.workspaceId}|${wayfarer.projectId}`,
  ];
  assert.equal(new Set(values).size, 3);
  assert.equal(abs.workspace.workspaceId, ABS_NEWS_WORKSPACE_ID_V1);
  assert.equal(abs.workspace.projectId, ABS_NEWS_PROJECT_ID_V1);
  assert.equal(wayfarer.workspaceId, WAYFARER_WORKSPACE_ID_V1);
  assert.equal(wayfarer.projectId, WAYFARER_PROJECT_ID_V1);
  assert.equal(content.every((record) => record.tenantId === content[0]!.tenantId
    && record.workspaceId === content[0]!.workspaceId && record.projectId === content[0]!.projectId), true);
});

test("CR9B-WF-130 each adapter rejects complete foreign project objects", () => {
  const { abs, content, wayfarer } = scopes();
  assert.throws(() => parseWayfarerProjectPackV1(abs.workspace), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerProjectPackV1(content[0]), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseAbsNewsStoryV1(wayfarer), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseAbsNewsStoryV1(content[0]), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseContentBloomsOperationalRecordV1(wayfarer), ContentBloomsContractErrorV1);
  assert.throws(() => parseContentBloomsOperationalRecordV1(abs.stories[0]), ContentBloomsContractErrorV1);
});

test("CR9B-WF-130 re-signed ABS scope cannot become a Wayfarer pack", () => {
  const pack = structuredClone(buildWayfarerSyntheticProjectPackV1());
  pack.tenantId = buildAbsNewsSyntheticWorkspaceV1().workspace.tenantId;
  const unsigned = { ...pack } as Record<string, unknown>;
  delete unsigned.packDigest;
  pack.packDigest = sha256Digest(unsigned);
  assert.throws(() => parseWayfarerProjectPackV1(pack),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "scope_mismatch");
});

test("CR9B-WF-130 delivery package and readiness records stay bound to Wayfarer only", () => {
  const abs = buildAbsNewsSyntheticWorkspaceV1();
  const delivery = buildCurrentWayfarerDeliveryDisabledV1();
  const readiness = buildCurrentWayfarerDeliveryReadinessDisabledV1();
  assert.equal(delivery.package.projectId, WAYFARER_PROJECT_ID_V1);
  assert.equal(readiness.records.every((record) => record.assessment.projectId === WAYFARER_PROJECT_ID_V1
    && record.disposition.projectId === WAYFARER_PROJECT_ID_V1), true);
  const foreign = structuredClone(delivery.package);
  foreign.projectId = abs.workspace.projectId;
  const material = { ...foreign } as Record<string, unknown>;
  delete material.packageDigest;
  foreign.packageDigest = sha256Digest(material);
  assert.throws(() => parseWayfarerDeliveryPreparationPackageV1(foreign), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-130 operator projection cannot be re-labeled as ABS or Content Blooms", () => {
  const view = structuredClone(buildWayfarerWorkspaceViewV1());
  const content = buildContentBloomsSyntheticFixtureRecordsV1()[0]!;
  view.projectId = content.projectId;
  const unsigned = { ...view } as Record<string, unknown>;
  delete unsigned.viewDigest;
  view.viewDigest = sha256Digest(unsigned);
  assert.throws(() => parseWayfarerWorkspaceViewV1(view), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-130 foreign Proxies are rejected without executing traps", () => {
  const abs = observedProxy(buildAbsNewsSyntheticWorkspaceV1().workspace, "transparent");
  const content = observedProxy(buildContentBloomsSyntheticFixtureRecordsV1()[0]!, "transparent");
  assert.throws(() => parseWayfarerProjectPackV1(abs.value), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerDeliveryPreparationPackageV1(content.value), ProjectWorkspaceContractErrorV1);
  assert.equal(abs.trapCount(), 0);
  assert.equal(content.trapCount(), 0);
});
