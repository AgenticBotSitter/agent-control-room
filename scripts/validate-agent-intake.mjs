#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Z0-9][A-Z0-9._-]{2,63}$/;
const INTEGRATION_BRANCH = /^integration\/[a-z0-9][a-z0-9._/-]*$/;
const PRODUCER_BRANCH = /^agent\/[a-z0-9][a-z0-9._/-]*$/;
const CAPSULE_SCHEMA = "control-room.agent-build-capsule/v2";
const RESULT_SCHEMA = "control-room.agent-build-result/v2";
const ROUTE = /^[a-z0-9][a-z0-9._-]{1,47}$/;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("arguments must be --name value pairs");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function isRepoPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || value.startsWith("./")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.split("/").includes("..") && !["*", "?", "[", "]"].some((character) => value.includes(character));
}

function arrayOf(value, predicate, { nonempty = false, unique = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0) || !value.every(predicate)) return false;
  return !unique || new Set(value).size === value.length;
}

function add(errors, condition, code) {
  if (!condition) errors.push(code);
}

function argumentMatchesRepoPath(argument, declaredPath) {
  const normalized = argument.replaceAll("\\", "/");
  return normalized === declaredPath || normalized.endsWith(`/${declaredPath}`);
}

function validateCapsule(capsule) {
  const errors = [];
  add(errors, capsule?.schema === CAPSULE_SCHEMA, "capsule_schema_invalid");
  add(errors, ID.test(capsule?.capsuleId ?? ""), "capsule_id_invalid");
  add(errors, ID.test(capsule?.waveId ?? ""), "wave_id_invalid");
  add(errors, typeof capsule?.block === "string" && capsule.block.length > 0, "block_missing");
  add(errors, typeof capsule?.summary === "string" && capsule.summary.length > 0 && capsule.summary.length <= 100, "summary_invalid");
  add(errors, ["any", "macos", "windows", "linux"].includes(capsule?.platform), "platform_invalid");
  add(errors, capsule?.status === "ready", "capsule_not_claimable");
  add(errors, ["standard-work", "platform-validation", "controlled-effect", "independent-review"].includes(capsule?.mode), "mode_invalid");
  add(errors, ["T0-mechanical", "T1-bounded-implementation", "T2-integration-candidate", "T3-platform-validation"].includes(capsule?.taskClass), "task_class_not_delegable");
  add(errors, ["low", "medium", "high", "critical"].includes(capsule?.risk), "risk_invalid");
  add(errors, SHA.test(capsule?.baseCommit ?? ""), "base_commit_invalid");
  add(errors, INTEGRATION_BRANCH.test(capsule?.integrationBranch ?? ""), "integration_branch_invalid");
  add(errors, arrayOf(capsule?.eligibleRoutes, (item) => ROUTE.test(item), { nonempty: true, unique: true }), "eligible_routes_invalid");
  const routeClaimants = capsule?.routeClaimants;
  add(errors, routeClaimants !== null && typeof routeClaimants === "object" && !Array.isArray(routeClaimants), "route_claimants_invalid");
  const claimantRoutes = routeClaimants && typeof routeClaimants === "object" ? Object.keys(routeClaimants) : [];
  add(errors, JSON.stringify([...claimantRoutes].sort()) === JSON.stringify([...(capsule?.eligibleRoutes ?? [])].sort()), "route_claimants_mismatch");
  for (const route of claimantRoutes) {
    add(errors, arrayOf(routeClaimants[route], (login) => /^[A-Za-z0-9-]{1,39}$/.test(login), { nonempty: true, unique: true }), `route_claimants_invalid:${route}`);
  }
  add(errors, arrayOf(capsule?.dependencies, (item) => ID.test(item), { unique: true }), "dependencies_invalid");
  add(errors, !(capsule?.dependencies ?? []).includes(capsule?.capsuleId), "capsule_depends_on_itself");
  add(errors, arrayOf(capsule?.requiredTools, (item) => typeof item === "string" && item.length > 0 && item.length <= 100, { unique: true }), "required_tools_invalid");
  add(errors, Number.isInteger(capsule?.maxConcurrentClaimsPerRoute) && capsule.maxConcurrentClaimsPerRoute >= 1 && capsule.maxConcurrentClaimsPerRoute <= 5, "claim_limit_invalid");
  add(errors, typeof capsule?.verification?.required === "boolean", "verification_rule_invalid");
  add(errors, ["none", "route", "profile", "harness", "model-family"].includes(capsule?.verification?.independence), "verification_independence_invalid");
  add(errors, capsule?.verification?.required || capsule?.verification?.independence === "none", "unneeded_verification_independence");
  add(errors, !capsule?.verification?.required || capsule?.verification?.independence !== "none", "required_verification_not_independent");
  add(errors, typeof capsule?.objective === "string" && capsule.objective.length > 0, "objective_missing");
  add(errors, arrayOf(capsule?.contractRefs, isRepoPath, { nonempty: true, unique: true }), "contract_refs_invalid");
  add(errors, arrayOf(capsule?.allowedPaths, isRepoPath, { nonempty: true, unique: true }), "allowed_paths_invalid");
  add(errors, arrayOf(capsule?.forbiddenPrefixes, isRepoPath, { unique: true }), "forbidden_prefixes_invalid");
  add(errors, arrayOf(capsule?.acceptanceCommands, (item) => typeof item === "string" && item.length > 0, { nonempty: true, unique: true }), "acceptance_commands_invalid");
  add(errors, arrayOf(capsule?.semanticAcceptance, (item) => typeof item === "string" && item.length > 0, { nonempty: true }), "semantic_acceptance_invalid");
  add(errors, Number.isInteger(capsule?.limits?.maxChangedFiles) && capsule.limits.maxChangedFiles > 0, "max_changed_files_invalid");
  add(errors, Number.isInteger(capsule?.limits?.maxChangedLines) && capsule.limits.maxChangedLines > 0, "max_changed_lines_invalid");
  add(errors, Number.isInteger(capsule?.limits?.maxRepairIterations) && capsule.limits.maxRepairIterations >= 0 && capsule.limits.maxRepairIterations <= 3, "repair_limit_invalid");
  add(errors, ["none", "bounded", "owner-attended"].includes(capsule?.effects?.level), "effect_level_invalid");
  add(errors, Number.isInteger(capsule?.effects?.maxCount) && capsule.effects.maxCount >= 0, "effect_limit_invalid");
  add(errors, capsule?.effects?.level !== "none" || capsule?.effects?.maxCount === 0, "none_effect_count_nonzero");
  add(errors, arrayOf(capsule?.stopConditions, (item) => typeof item === "string" && item.length > 0, { nonempty: true }), "stop_conditions_invalid");
  add(errors, isRepoPath(capsule?.resultManifestPath), "result_manifest_path_invalid");
  add(errors, capsule?.resultManifestPath === `coordination/agent-build/results/${capsule?.capsuleId}.json`, "result_manifest_path_noncanonical");
  for (const allowed of capsule?.allowedPaths ?? []) {
    add(errors, !(capsule?.forbiddenPrefixes ?? []).some((prefix) => allowed === prefix || allowed.startsWith(`${prefix}/`)), `allowed_path_forbidden:${allowed}`);
  }
  return [...new Set(errors)];
}

function validateResult(result, capsule) {
  const errors = [];
  add(errors, result?.schema === RESULT_SCHEMA, "result_schema_invalid");
  add(errors, isRepoPath(result?.capsulePath), "capsule_path_invalid");
  add(errors, result?.capsuleId === capsule?.capsuleId, "capsule_id_mismatch");
  add(errors, result?.waveId === capsule?.waveId, "wave_id_mismatch");
  add(errors, result?.baseCommit === capsule?.baseCommit, "base_commit_mismatch");
  add(errors, SHA.test(result?.implementationCommit ?? ""), "implementation_commit_invalid");
  add(errors, ROUTE.test(result?.producerRoute ?? "") && capsule?.eligibleRoutes?.includes(result.producerRoute), "producer_route_ineligible");
  add(errors, Array.isArray(result?.changedFiles) && result.changedFiles.length > 0, "changed_files_missing");
  const changedPaths = [];
  for (const file of result?.changedFiles ?? []) {
    add(errors, isRepoPath(file?.path), "changed_file_path_invalid");
    add(errors, Number.isInteger(file?.additions) && file.additions >= 0, `additions_invalid:${file?.path ?? "unknown"}`);
    add(errors, Number.isInteger(file?.deletions) && file.deletions >= 0, `deletions_invalid:${file?.path ?? "unknown"}`);
    changedPaths.push(file?.path);
  }
  add(errors, new Set(changedPaths).size === changedPaths.length, "changed_files_duplicate");
  add(errors, changedPaths.every((item) => capsule?.allowedPaths?.includes(item)), "changed_files_outside_capsule");
  add(errors, changedPaths.length <= (capsule?.limits?.maxChangedFiles ?? -1), "changed_file_limit_exceeded");
  const lineCount = (result?.changedFiles ?? []).reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
  add(errors, lineCount <= (capsule?.limits?.maxChangedLines ?? -1), "changed_line_limit_exceeded");
  add(errors, Array.isArray(result?.commands), "commands_invalid");
  for (const expected of capsule?.acceptanceCommands ?? []) {
    const observed = result?.commands?.find((entry) => entry?.command === expected);
    add(errors, observed !== undefined, `acceptance_command_missing:${expected}`);
    add(errors, observed?.exitCode === 0, `acceptance_command_failed:${expected}`);
  }
  add(errors, Number.isInteger(result?.repairIterations) && result.repairIterations >= 0 && result.repairIterations <= (capsule?.limits?.maxRepairIterations ?? -1), "repair_limit_exceeded");
  add(errors, Array.isArray(result?.failures), "failures_invalid");
  add(errors, Array.isArray(result?.assumptions), "assumptions_invalid");
  add(errors, Number.isInteger(result?.effectCount) && result.effectCount >= 0 && result.effectCount <= (capsule?.effects?.maxCount ?? -1), "effect_limit_exceeded");
  add(errors, result?.safety?.secretsAbsent === true, "secrets_confirmation_missing");
  add(errors, result?.safety?.privateHostDataAbsent === true, "private_host_data_confirmation_missing");
  add(errors, result?.safety?.workerDidNotApproveOrMerge === true, "no_self_merge_confirmation_missing");
  add(errors, result?.safety?.scopeNotExpanded === true, "scope_confirmation_missing");
  add(errors, result?.disposition === "ready-for-intake", "result_not_ready_for_intake");
  return [...new Set(errors)];
}

function git(arguments_) {
  return spawnSync("git", arguments_, { encoding: "utf8" });
}

function validateGit(capsule, result, args) {
  if (!args.head && !args.branch && !args.target && !args["target-base"]) return { errors: [], changed: [] };
  const errors = [];
  add(errors, SHA.test(args?.head ?? ""), "observed_head_invalid");
  add(errors, SHA.test(args?.["target-base"] ?? ""), "observed_target_base_invalid");
  const expectedProducerBranch = `agent/${result.producerRoute}/${capsule.capsuleId.toLowerCase()}`;
  add(errors, PRODUCER_BRANCH.test(args?.branch ?? "") && args.branch === expectedProducerBranch, "observed_branch_mismatch");
  add(errors, args.target === capsule.integrationBranch, "observed_target_mismatch");
  add(errors, git(["merge-base", "--is-ancestor", capsule.baseCommit, args["target-base"]]).status === 0, "product_base_not_ancestor_of_target");
  add(errors, git(["merge-base", "--is-ancestor", args["target-base"], result.implementationCommit]).status === 0, "target_base_not_ancestor_of_implementation");
  add(errors, git(["merge-base", "--is-ancestor", result.implementationCommit, args.head]).status === 0, "implementation_not_ancestor_of_head");
  const names = git(["diff", "--name-only", "--diff-filter=ACMRDTUXB", `${args["target-base"]}...${result.implementationCommit}`]);
  if (names.status !== 0) return { errors: [...errors, "git_diff_failed"], changed: [] };
  const changed = names.stdout.split(/\r?\n/).filter(Boolean);
  const expected = result.changedFiles.map((file) => file.path).sort();
  add(errors, JSON.stringify([...changed].sort()) === JSON.stringify(expected), "git_changed_paths_mismatch");
  const stats = git(["diff", "--numstat", `${args["target-base"]}...${result.implementationCommit}`]);
  add(errors, stats.status === 0, "git_numstat_failed");
  const byPath = new Map(result.changedFiles.map((file) => [file.path, file]));
  for (const line of stats.stdout.split(/\r?\n/).filter(Boolean)) {
    const [additions, deletions, file] = line.split("\t");
    const declared = byPath.get(file);
    add(errors, additions !== "-" && deletions !== "-", `binary_change_forbidden:${file}`);
    add(errors, declared?.additions === Number(additions) && declared?.deletions === Number(deletions), `line_stat_mismatch:${file}`);
  }
  const metadataNames = git(["diff", "--name-only", "--diff-filter=ACMRDTUXB", `${result.implementationCommit}...${args.head}`]);
  add(errors, metadataNames.status === 0, "metadata_diff_failed");
  add(errors, JSON.stringify(metadataNames.stdout.split(/\r?\n/).filter(Boolean).sort()) === JSON.stringify([capsule.resultManifestPath]), "metadata_commit_not_isolated");
  add(errors, git(["diff", "--quiet", args["target-base"], args.head, "--", result.capsulePath]).status === 0, "capsule_modified_by_producer");
  const whitespace = git(["diff", "--check", `${args["target-base"]}...${args.head}`]);
  add(errors, whitespace.status === 0, "diff_check_failed");
  return { errors: [...new Set(errors)], changed };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.mode === "capsule") {
      if (!args.capsule) throw new Error("capsule mode requires --capsule");
      const capsule = readJson(args.capsule);
      const errors = validateCapsule(capsule);
      const report = {
        schema: "control-room.agent-build-capsule-validation/v2",
        ok: errors.length === 0,
        disposition: errors.length === 0 ? "claimable" : "draft-or-invalid",
        capsuleId: capsule.capsuleId ?? null,
        waveId: capsule.waveId ?? null,
        errors: [...new Set(errors)].sort()
      };
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    if (args["discover-base"]) {
      if (!SHA.test(args["discover-base"]) || !SHA.test(args?.head ?? "")) throw new Error("discovery requires valid --discover-base and --head commits");
      const discovered = git(["diff", "--name-only", "--diff-filter=ACMRDTUXB", `${args["discover-base"]}...${args.head}`, "--", "coordination/agent-build/results"]);
      if (discovered.status !== 0) throw new Error("result discovery git diff failed");
      const resultPaths = discovered.stdout.split(/\r?\n/).filter(Boolean);
      if (resultPaths.length !== 1 || !/^coordination\/agent-build\/results\/[A-Z0-9][A-Z0-9._-]{2,63}\.json$/.test(resultPaths[0])) {
        throw new Error(`expected one canonical result manifest; found ${resultPaths.length}`);
      }
      args.result = resultPaths[0];
      const discoveredResult = readJson(args.result);
      if (!isRepoPath(discoveredResult?.capsulePath) || !/^coordination\/agent-build\/capsules\/[A-Z0-9][A-Z0-9._-]{2,63}\.json$/.test(discoveredResult.capsulePath)) {
        throw new Error("discovered result contains a noncanonical capsule path");
      }
      args.capsule = discoveredResult.capsulePath;
      args["target-base"] = args["discover-base"];
    }
    if (!args.capsule || !args.result) throw new Error("--capsule and --result are required unless --discover-base is used");
    const capsule = readJson(args.capsule);
    const result = readJson(args.result);
    const errors = [...validateCapsule(capsule), ...validateResult(result, capsule)];
    add(errors, argumentMatchesRepoPath(args.capsule, result.capsulePath), "capsule_path_argument_mismatch");
    add(errors, argumentMatchesRepoPath(args.result, capsule.resultManifestPath), "result_path_argument_mismatch");
    const gitReport = validateGit(capsule, result, args);
    errors.push(...gitReport.errors);
    const report = {
      schema: "control-room.agent-build-intake-report/v2",
      ok: errors.length === 0,
      disposition: errors.length === 0 ? "eligible" : "quarantined",
      capsuleId: capsule.capsuleId ?? null,
      waveId: capsule.waveId ?? null,
      changed: gitReport.changed,
      errors: [...new Set(errors)].sort()
    };
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      schema: "control-room.agent-build-intake-report/v2",
      ok: false,
      disposition: "quarantined",
      errors: ["validator_error"],
      detail: error instanceof Error ? error.message : String(error)
    }, null, 2));
    return 2;
  }
}

process.exitCode = main();
