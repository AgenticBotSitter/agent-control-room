import assert from "node:assert/strict";
import test from "node:test";
import { execFile,execFileSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec=promisify(execFile),root=resolve("."),file="tests/helpers/improve-control-room-first-website.ts";
// Each probe disables one NEW B5 verifier guard. The forged proof in its named case
// must then fail that case's own intended assertion; unchanged product/A2 guards are not re-mutated.
const probes=[
  {name:"real versus fixture qualification",find:`  if (b.toolingRevision !== pins.toolingRevision) refuse("B5_FIXTURE_NOT_REAL", "card tooling");`,
  replace:"",pattern:"B5 verifier refuses a fixture chain presented as real",assertion:"B5 forged fixture chain is refused by its own guard"},
  {name:"rejected and final head binding",find:`  if (card.candidateRevision !== final) refuse("B5_HEAD_BINDING", "card head");`,replace:"",
    pattern:"B5 verifier binds rejected and final heads to the saved card",assertion:"B5 stale card head is refused by the head guard"},
  {name:"candidate repository HEAD and clean state",find:`  if (facts.head !== card.candidateRevision || facts.head !== manifest.heads.final || !facts.clean) bad("head");`,replace:"",
    pattern:"B5 verifier re-reads the candidate repository and its page facts",assertion:"B5 dirty candidate repository is refused"},
  {name:"artifact byte binding",find:"if (b5Bytes(bytes) !== entry.sha256 || bytes.length !== entry.bytes || artifacts.has(entry.path))",replace:"if (artifacts.has(entry.path))",
    pattern:"B5 verifier accepts complete real-shaped evidence and reports missing phone evidence as incomplete",assertion:"B5 changed retained bytes are refused"},
  {name:"closed-browser rejection and original-builder repair",find:"if (!repair || repair.identity !== defective!.identity || repair.family !== defective!.family)",replace:"if (!repair)",
    pattern:"B5 verifier requires closed-browser rejection and original-builder repair",assertion:"B5 repair by a different writer is refused by the repair guard"},
  {name:"full cleanup and retained corpus",find:`if (teardown.b3cCleanup !== "complete" || !teardown.scratchAbsent || `,replace:"if (",
    pattern:"B5 verifier requires full cleanup before the retained read-back",assertion:"B5 refused cleanup is refused by the cleanup guard"},
  {name:"mandatory provider discriminator",find:'  if (rawManifest && rawManifest.classification?.providers === undefined) refuse("B5_PROVIDER_PROVENANCE_MISSING");',replace:"",
    pattern:"F04b missing provider provenance refuses complete-looking evidence",assertion:"F04b missing discriminator cannot obtain real success"},
  {name:"fixture provider verdict",find:'return p.transport === "scripted" ? ["B5_PROVIDER_FIXTURE"] : [];',replace:'return [];',
    pattern:"F04b provider relabelling cannot promote scripted transport or change lineup",assertion:"F04b scripted provider always remains incomplete"},
  {name:"complete owner action list",find:'  assertB5ActionEvidenceV1(journey, card, teardown, artifacts, input.pins, http?.responseDigest);',replace:"",
    pattern:"F04b evidence action list requires all owner gates and cold retained reads",assertion:"F04b intake plus Confirm is insufficient evidence"},
  {name:"capture qualification",find:'if (!pins.capture || !sha256.safeParse(pins.capture.qualificationDigest).success || j.phoneCapture !== pins.capture.phoneCapture || j.captureQualificationDigest !== pins.capture.qualificationDigest)',replace:'if (false)',
    pattern:"F04b capture correlation refuses swapped device, wrong head, request and bytes",assertion:"F04b capture qualification independently pinned"},
  {name:"service capture head correlation",find:'|| f.candidateRevision !== card.candidateRevision',replace:'',
    pattern:"F04b capture correlation refuses swapped device, wrong head, request and bytes",assertion:"F04b mismatched capture/service joins refuse"},
  {name:"device closure attestations",find:'for (const closed of j.closed) {',replace:'for (const closed of [] as typeof j.closed) {',
    pattern:"F04b closure evidence requires actual owner attestations on both devices",assertion:"F04b device closure receipt required"},
  {name:"cold read before shared teardown",find:'  await input.finishTeardown?.();',replace:'',
    pattern:"F04a verifier captures the cold card then awaits shared teardown before loading final bytes",assertion:"same outer teardown must run after cold card and before artifact reads"},
  {name:"provider manifest versus independent pins",find:'  if (manifest.classification.providers !== p.classification) refuse("B5_PROVIDER_PROVENANCE_MISMATCH");',replace:'',
    pattern:"F04b provider relabelling cannot promote scripted transport or change lineup",assertion:"F04b manifest label cannot promote fixture pins"},
  {name:"narrow unauthenticated snapshot",find:'if (Object.keys(e.row).length !== columns.length || columns.some(k => !(k in e.row)))',replace:'if (false)',
    pattern:"F04b snapshot is a narrow unauthenticated projection",assertion:"F04b projection excludes auth tags even with recomputed hashes"},
  {name:"observed cleanup target absence",find:'    if (await lstat(target).then(() => true, e => { if(e.code === "ENOENT") return false; throw e; })) refuse("B5_CLEANUP_RETAINED");',replace:'',
    pattern:"F04b finalization preserves shared retained repository and hashes only run cleanup targets",assertion:"F04b live cleanup target cannot be reported absent"},
  {name:"independent capture approval",find:'  if (input.pins.capture.approval !== "approved") reasons.push("B5_CAPTURE_MODE_UNAPPROVED");',replace:'',
    pattern:"F04b native phone evidence cannot clear pending capture approval or absent cleanup",assertion:"F04b capture approval cannot be inferred from screenshots"},
  {name:"private artifact mode",find:'    if ((stat.mode & 0o777) !== 0o600) refuse("B5_ARTIFACT_BYTES");\n    try { return await readFirstWebsitePrivateBytesV1',replace:'    try { return await readFirstWebsitePrivateBytesV1',
    pattern:"F04b private artifacts refuse traversal, symlinks, truncation, duplicate paths and public modes",assertion:"F04b public artifact mode refuses"},
  {name:"retained owner removal receipt",find:'|| !b5RemovedMappingEvidenceMatchesV1(cleanup,manifest,artifacts,input.pins)',replace:'',
    pattern:"F04b removed mapping claims require retained owner receipt and unchanged status",assertion:"F04b nonzero owner removal cannot be relabeled removed"},
  {name:"complete qualified lineup",find:'  if (p.lineup.some(q=>!admitted.has(key(q)))) refuse("B5_PROVIDER_PROVENANCE_MISMATCH");',replace:'',
    pattern:"F04b provider relabelling cannot promote scripted transport or change lineup",assertion:"F04b qualified lineup cannot omit an admitted role"},
  {name:"native receipt route admission",target:"scripts/workflow-journeys/first-website-controller.ts",find:'&& slot.route === route',replace:'',
    pattern:"F04b controller writes complete fixture evidence from accepted receipts after the cold read",assertion:"F04b writer must compare actual native receipt route with qualified provenance"},
  {name:"actual staged provider provenance",find:'    if(!marker.success || providers.classification !== "fixture" || providers.transport !== "scripted") refuse("B5_PROVIDER_PROVENANCE_MISMATCH");',replace:'',
    pattern:"F04b staged fixture marker refuses real qualification even without a rehearsal label",assertion:"F04b actual staged fixture cannot be promoted by relabeling qualified data"},
  {name:"complete final website report",find:'  if (!card.evidence.summary?.trim() || !card.evidence.changedAreas?.includes("index.html") || card.evidence.databaseChanges?.kind !== "none"\n    || card.evidence.assumptions === null || card.evidence.validations === null) refuse("B5_FULL_REPORT_INCOMPLETE");',replace:'',
    pattern:"F04b full website report cannot qualify with absent final sections",assertion:"F04b each required final report section must be present"},
  {name:"selected identity admission",find:'&& s.identity === (selected ? review.selectedModel : review.observedModel)',replace:'',
    pattern:"F04b R295 selected review identities join without claiming observation",assertion:"F04b selected model must match admitted journey"},
  {name:"screen response versus signed cold record",find:'&& r.recordDigest === card.recordDigest',replace:'',
    pattern:"F04b per-screen HTTP receipts bind distinct envelopes to the authoritative cold card",assertion:"a different signed card cannot be hidden by fresh response hashes"},
  {name:"controller missing qualification",find:'  if (packet === undefined) refuse("B5_A2_QUALIFICATION_REQUIRED");',replace:"",
    lane:"tests/improve-control-room-first-website-controller-postgres.test.ts",pattern:"B5 controller-postgres missing qualification refuses before acquisition",assertion:"B5 controller-postgres missing qualification guard"},
];
test("B5 verifier guard mutations bite independently and restore green",{timeout:290000},async t=>{
  await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b5-mutations-"));
  try{
    execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
    await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
    // Exercise current uncommitted bytes; never accidentally test only the clone's old HEAD.
    for (const path of [file,"scripts/workflow-journeys/first-website-device.ts","scripts/workflow-journeys/first-website-controller.ts","scripts/workflow-journeys/first-website-host.ts","tests/improve-control-room-first-website.test.ts","tests/improve-control-room-first-website-controller-postgres.test.ts"])
      await writeFile(join(copy,path),await readFile(join(root,path)));
    for(const p of probes)await t.test(p.name,async()=>{
      const cmd=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${p.pattern}$`,p.lane ?? "tests/improve-control-room-first-website.test.ts"];
      const target=("target" in p ? p.target : undefined) ?? file;
      const original=await readFile(join(copy,target),"utf8");
      const result=await assertGuardBites({root:copy,file:target,find:p.find,replace:p.replace,testCmd:cmd,boundMs:40000,allowDirtyTree:true,because:p.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(p.assertion),`B5 loaded mutant reached intended assertion: ${p.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out/iu);
      assert.equal(await readFile(join(copy,target),"utf8"),original);
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(cmd[0]!,cmd.slice(1),{cwd:copy,env,timeout:40000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B5 mutation ${p.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
