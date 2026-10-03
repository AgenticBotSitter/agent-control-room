import { pipelineStageUsageV1 } from "../src/pipelines/v1/stage-usage";
import assert from "node:assert/strict";
import test from "node:test";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "../src/work-intake/v1/schemas";
import { workBatchOwnerItemSchemaV1, workBatchQueueItemSchemaV1 } from "../src/work-intake/v1/owner-schemas";
import { buildCompareAndCombineProposalV1 } from "../src/work-intake/v1/compare-combine-template";
import { computeIntakeFlagsV1, applySuggestedSplitV1 } from "../src/work-intake/v1/intake-gate";
import { pipelineStageTemplateSchemaV1 } from "../src/pipelines/v1/schemas";
import { browseProjectPackV1, refusalTextV1, PROJECT_PACK_MAX_BYTES_V1 } from "../src/project-packs/v1/browse-preview";
import { PROJECT_PACK_SCHEMA_V1 } from "../src/project-packs/v1/project-pack";
import { getRegisteredModuleManifestV1 } from "../src/modules/v1/registry";
import { assertModulePermissionDiffV1, moduleAuthoritySurfaceV1, modulePermissionDiffV1 } from "../src/modules/v1/bundle";

const task = (localId: string) => ({ localId, title: "One part", instructions: "Do the exact thing.",
  requiredCapability: "code.change", role: "builder" as const, acceptanceCriteria: "An exact checkable result.",
  acceptanceTests: "Check the exact result." });
const proposal = (tasks:WorkBatchProposalV1["tasks"] = [task("a"), task("ab")]) => workBatchProposalSchemaV1.parse({
  schema: "control-room.work-batch-proposal/v1", projectId: "project:test", tasks, edges: [] });

test("R7L-02: every legal local ID reads back in items, dependencies and queues", () => {
  for (const localId of ["a", "ab", "abc", "a".repeat(64)]) {
    const item = { ...task(localId), ordinal: 0, dependsOnLocalIds: ["a", "ab"],
      requestedWorkerId: null, requestedWorkerKind: null, requestedModelKey: null,
      decisionState: "approved", decisionReasonCode: null, jobId: "job:test" };
    const { title: _title, instructions: _instructions, ...readItem } = item;
    assert.equal(workBatchOwnerItemSchemaV1.safeParse(readItem).success, true, localId);
    assert.equal(workBatchQueueItemSchemaV1.safeParse({ localId, jobId: "job:test", workerId: "worker:test",
      workerKind: "codex", nodeId: "node:test", position: 1, queueDepthLimit: 10, selectionKey: "o1",
      model: "o1", effort: "high", provider: null, profile: null, state: "ready_for_assignment" }).success, true);
  }
});

test("R7L-03: profiles on one worker cannot masquerade as independent answerers", () => {
  const step = (workerId: string, model: string) => ({ ...task("a"), requestedWorkerId: workerId,
    requestedWorkerKind: "hermes", requestedModelKey: model });
  const { localId: _local, role: _role, ...first } = step("worker:one", "deep");
  const { localId: _local2, role: _role2, ...second } = step("worker:one", "fast");
  const { localId: _local3, role: _role3, ...combiner } = step("worker:two", "deep");
  assert.throws(() => buildCompareAndCombineProposalV1({ schema: "control-room.compare-and-combine-template/v1",
    projectId: "project:test", question: "Compare these approaches.", answerers: [first, second], combiner }), /distinct/);
});

test("R7L-10: vague and too-short concerns are both visible", () => {
  assert.deepEqual(computeIntakeFlagsV1({ instructions: "Do one thing.", acceptanceCriteria: "tbd", acceptanceTests: "ok" })
    .map(flag => flag.reasonCode), ["vague_language_used", "acceptance_detail_too_short"]);
});

test("R7L-11: suggested splits never return an invalid proposal", () => {
  const parts = proposal([{ ...task("part-1"), instructions: "- First\n- Second",
    acceptanceCriteria: "- First done\n- Second done" }, task("part-1-1")]);
  assert.equal(applySuggestedSplitV1(parts, "part-1"), null);
  for (const patch of [{ localId: "a".repeat(64) }, { title: "a".repeat(180) }]) {
    const value = proposal([{ ...parts.tasks[0]!, ...patch }]);
    assert.equal(applySuggestedSplitV1(value, value.tasks[0]!.localId), null);
  }
});

test("R7L-12: protected model keys are expressible at every proposal/template boundary", () => {
  for (const model of ["a", "o1", "vendor/model", "gpt-4.1", "provider:model+profile"]) {
    assert.equal(workBatchProposalSchemaV1.safeParse({ ...proposal(), tasks: [{ ...task("a"), requestedModelKey: model }] }).success, true, model);
    assert.equal(pipelineStageTemplateSchemaV1.safeParse({ ordinal: 1, stageKind: "check", role: "checker",
      description: "Check the work.", requiredCapability: "code.review", workerId: "worker:test", workerKind: "hermes",
      nodeId: "node:test", selectionKey: model, model, effort: "default", provider: model, profile: model, maxLoops: 2 }).success, true, model);
  }
});

const local = { ideaLab: true, news: true, sessionObservations: true };
const pack = { schema: PROJECT_PACK_SCHEMA_V1, title: "A project pack", summary: "The summary.",
  optionalModules: ["ideaLab"], setupGuidance: ["Pick a bounded task."] };
test("R7L-08: valid JSON structural refusals preserve their reason and name the field", () => {
  const variants = [
    { ...pack, optionalModules: ["ideaLab", "ideaLab"] },
    { ...pack, optionalModules: ["unknown"] },
    { ...pack, optionalModules: ["news", "ideaLab"] },
    { ...pack, title: "a".repeat(181) }, { ...pack, summary: "" },
    { ...pack, unexpected: true }, { ...pack, setupGuidance: "wrong" },
  ];
  for (const variant of variants) {
    const result = browseProjectPackV1({ rawText: JSON.stringify(variant) }, local);
    assert.equal(result.status, "refused");
    if (result.status === "refused") {
      assert.notEqual(result.reason, "project_pack_read_failed");
      assert.doesNotMatch(refusalTextV1(result.reason), /not valid JSON/);
    }
  }
  const invalidTitle=browseProjectPackV1({rawText:JSON.stringify({...pack,title:"a".repeat(121)})},local);
  assert.equal(invalidTitle.status,"refused");
  if(invalidTitle.status==="refused")assert.match(refusalTextV1(invalidTitle.reason),/title.*120-character/);
  const unknown=browseProjectPackV1({rawText:JSON.stringify({...pack,unexpected:true})},local);
  assert.equal(unknown.status,"refused");
  if(unknown.status==="refused")assert.match(refusalTextV1(unknown.reason),/unknown field: unexpected/);
  for (const value of [null, [], 3]) assert.deepEqual(browseProjectPackV1({ rawText: JSON.stringify(value) }, local),
    { status: "refused", reason: "project_pack_malformed" });
});

test("R7L-14: whitespace and NUL-only input are empty, and the byte ceiling wins", () => {
  for (const rawText of ["", " \n\t ", "\0", " \0\t\0 "]) assert.deepEqual(browseProjectPackV1({ rawText }, local),
    { status: "refused", reason: "project_pack_empty" });
  assert.deepEqual(browseProjectPackV1({ rawText: " ".repeat(PROJECT_PACK_MAX_BYTES_V1 + 1) }, local),
    { status: "refused", reason: "project_pack_input_oversized" });
  assert.equal(browseProjectPackV1({ rawText: ` \n${JSON.stringify(pack)}\t ` }, local).status, "ready");
});

test("R7L-09: repeated declarations and identity changes have a nonempty permission diff", () => {
  const manifest = getRegisteredModuleManifestV1("news")!;
  const surface = moduleAuthoritySurfaceV1(manifest);
  const duplicate = structuredClone(manifest);
  duplicate.permissions.taskTemplates.push(duplicate.permissions.taskTemplates[0]!);
  for (const widened of [duplicate, { ...manifest, publisher: "Another publisher" },
    { ...manifest, name: "Another display title" },
    { ...manifest, permissions: { ...manifest.permissions, workerCapabilities: [...manifest.permissions.workerCapabilities, "network.egress"] } }]) {
    const diff = modulePermissionDiffV1(surface, moduleAuthoritySurfaceV1(widened));
    assert.ok(diff.added.length + diff.removed.length > 0);
  }
});


test("R7L-09: empty diffs refuse a change in authority even when a field was omitted from the surface", () => {
  const before = getRegisteredModuleManifestV1("news")!;
  const after = { ...before, permissions:{ ...before.permissions, workerCapabilities:[...before.permissions.workerCapabilities,"network.egress"] } };
  assert.throws(() => assertModulePermissionDiffV1(before,after,{added:[],removed:[]}), /module_permission_diff_empty/);
  assert.doesNotThrow(() => assertModulePermissionDiffV1(before,before,{added:[],removed:[]}));
});


test("R7L-08/14: 50 refused inputs remain inert and a valid retry succeeds", async () => {
  const before=Object.getOwnPropertyDescriptor(globalThis,"Buffer");
  const results=await Promise.all(Array.from({length:50},(_,index)=>Promise.resolve(browseProjectPackV1({
    rawText:index%2?" \0 ":JSON.stringify({...pack,setupGuidance:false})},local))));
  assert.ok(results.every(result=>result.status==="refused"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,"Buffer"),before);
  assert.equal(browseProjectPackV1({rawText:JSON.stringify(pack)},local).status,"ready");
});


test("R7L-06: unreported usage remains unknown, while partial reported usage stays explicit", () => {
  const totals={runs:1,inputTokens:null,outputTokens:null,totalTokens:null,wallTimeMs:null,knownCostNanoUsd:"0",
    knownCostRuns:0,subscriptionRuns:0,unknownCostRuns:1,unknownCostReasons:["usage_not_reported" as const]};
  assert.equal(pipelineStageUsageV1({usageRollup:totals,attempts:[],earlierAttemptsOmitted:false}),"unknown");
  assert.equal(pipelineStageUsageV1({usageRollup:{...totals,runs:0,inputTokens:0,outputTokens:0,totalTokens:0,wallTimeMs:0},attempts:[],earlierAttemptsOmitted:false}),"unknown");
  const partial=pipelineStageUsageV1({usageRollup:{...totals,inputTokens:0},attempts:[],earlierAttemptsOmitted:false});
  assert.notEqual(partial,"unknown");
  if(partial!=="unknown")assert.equal(partial.totals.outputTokens,null);
});


test("R7L-12: malformed model keys are refused by every shared boundary", () => {
  for(const model of ["", "/model", "space key", "line\nbreak", "x".repeat(181)]) {
    assert.equal(workBatchProposalSchemaV1.safeParse({...proposal(),tasks:[{...task("a"),requestedModelKey:model}]}).success,false);
    assert.equal(pipelineStageTemplateSchemaV1.safeParse({ordinal:1,stageKind:"check",role:"checker",description:"Check.",
      requiredCapability:"code.review",workerId:"worker:test",workerKind:"codex",nodeId:"node:test",selectionKey:"a",
      model,effort:"medium",maxLoops:1}).success,false);
  }
});

test("R7L-03: comparison requires exact workers and a separate combiner and presenter", () => {
  const step=(worker:string,model:string)=>({title:"A stage",instructions:"Answer independently.",requiredCapability:"code.change",
    requestedWorkerId:worker,requestedWorkerKind:"hermes",requestedModelKey:model,
    acceptanceCriteria:"A checkable answer here.",acceptanceTests:"Check the answer."});
  const input={schema:"control-room.compare-and-combine-template/v1",projectId:"project:test",question:"Compare options.",
    answerers:[step("worker:first","deep"),step("worker:second","fast")],combiner:step("worker:third","combine")};
  assert.throws(()=>buildCompareAndCombineProposalV1({...input,combiner:step("worker:first","different")}),/combiner/);
  assert.throws(()=>buildCompareAndCombineProposalV1({...input,presenter:step("worker:first","different")}),/presenter/);
  assert.throws(()=>buildCompareAndCombineProposalV1({...input,presenter:step("worker:third","different")}),/presenter/);
  const {requestedWorkerId:_worker,...unpinned}=input.answerers[0]!;
  assert.throws(()=>buildCompareAndCombineProposalV1({...input,answerers:[unpinned,input.answerers[1]!]}));
});

test("R7L-08: syntax errors retain the JSON reason and executable text keeps its canonical reason", () => {
  assert.deepEqual(browseProjectPackV1({rawText:"{not json"},local),{status:"refused",reason:"project_pack_read_failed"});
  const hostile=browseProjectPackV1({rawText:JSON.stringify({...pack,title:"<script>call()</script>"})},local);
  assert.deepEqual(hostile,{status:"refused",reason:"project_pack_title_executable_content"});
});
