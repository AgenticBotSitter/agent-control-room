#!/usr/bin/env python3
"""S7b self-test: break each guard on purpose and confirm a test catches it.

Every mutation is reverted from git afterwards. The tree must end clean.
"""
import subprocess, sys, pathlib, os, shutil, tempfile

REPO = pathlib.Path("/Users/alastairfraser/work/acr-cook-s7b")
SVC = REPO / "src/pipelines/v1/advance-service.ts"
ENV = {**os.environ, "PG_BIN": "/opt/homebrew/opt/postgresql@17/bin", "S7B_PG_PORT": "58700"}
UNIT = "tests/pipeline-sequential-advance.test.ts"
PG = "tests/postgres-pipeline-caps.test.mjs"

# label, file, old, new, which runner
MUTATIONS = [
    # --- installation allowance comparisons (real-login PG tests) ---
    ("runs/hour ceiling comparison", SVC,
     "if (runsThisHour+1>runsPerHour) refuse(\"installation_runs_per_hour_exhausted\");",
     "if (runsThisHour+1>=runsPerHour) refuse(\"installation_runs_per_hour_exhausted\");", "pg"),
    ("runs/agent/day comparison", SVC,
     "if (agentRunsToday+1>runsPerAgentPerDay) refuse(\"installation_agent_runs_per_day_exhausted\");",
     "if (agentRunsToday+1>=runsPerAgentPerDay) refuse(\"installation_agent_runs_per_day_exhausted\");", "pg"),
    ("agent process ceiling comparison", SVC,
     "if (activeProcesses+1>agentCeiling) refuse(\"installation_agent_process_ceiling_reached\");",
     "if (activeProcesses+1>=agentCeiling) refuse(\"installation_agent_process_ceiling_reached\");", "pg"),
    ("db cluster ceiling comparison", SVC,
     "if (dbClusters + 1 > clusterCeiling) refuse(\"installation_db_cluster_ceiling_reached\");",
     "if (dbClusters + 1 >= clusterCeiling) refuse(\"installation_db_cluster_ceiling_reached\");", "pg"),
    ("dollar cap comparison", SVC,
     "if (cap!==null&&nextCostMicroUsd!==null&&(spent>cap||nextCostMicroUsd>cap-spent))",
     "if (cap!==null&&nextCostMicroUsd!==null&&(spent>cap||nextCostMicroUsd>cap))", "pg"),
    ("a stale cluster count is not a pass", REPO / "src/pipelines/v1/installation-allowance.ts",
     "if (millis(observedAt) > nowMillis || nowMillis - millis(observedAt) > 86_400_000)",
     "if (millis(observedAt) > nowMillis)", "pg"),
    ("allowance row must exist", SVC,
     "if (!row) refuse(\"installation_allowance_missing\");",
     "if (!row) return { cost:{spent:0,cap:null,next:nextCostMicroUsd}, runsThisHour:0, agentRunsToday:0,\n"
     "      activeProcesses:0, runsPerHour:0, runsPerAgentPerDay:0, agentCeiling:0, clusterCeiling:0, dbClusters:0 };", "pg"),
    # --- loop ceilings (both runners) ---
    ("stage loop ceiling comparison", SVC,
     "const reasonCode = current.stageRounds > current.maxLoops",
     "const reasonCode = current.stageRounds >= current.maxLoops", "unit"),
    ("run loop ceiling comparison", SVC,
     ": nextRunTotal >= current.maxTotalLoops ? \"pipeline_run_loop_limit_reached\" as const : undefined;",
     ": nextRunTotal > current.maxTotalLoops ? \"pipeline_run_loop_limit_reached\" as const : undefined;", "unit"),
    ("in-transaction stage loop refusal", SVC,
     "if (loopIndex > maxLoops || nextRunTotal > maxTotalLoops) {",
     "if (loopIndex > maxLoops + 1 || nextRunTotal > maxTotalLoops) {", "pg"),
    ("loop stop stays inside the ceiling", SVC,
     "const lastStartedRound = Math.min(current.stageRounds, current.maxLoops);",
     "const lastStartedRound = current.stageRounds;", "pg"),
    # --- unknown cost advances (never refuses) ---
    ("unknown cost is stored as unknown", SVC,
     "delegationCostState:costKnown?\"known\":\"unknown\",",
     "delegationCostState:costKnown?\"known\":\"known\",", "pg"),
    ("cost cap counts what was already spent", SVC,
     "if (cap!==null&&nextCostMicroUsd!==null&&(spent>cap||nextCostMicroUsd>cap-spent))",
     "if (cap!==null&&nextCostMicroUsd!==null&&(nextCostMicroUsd>cap))", "pg"),
    ("a set dollar cap still refuses a known cost", SVC,
     "if(installationCostCap.cap!==null&&installationCostCap.next!==null",
     "if(false&&installationCostCap.cap!==null&&installationCostCap.next!==null", "pg"),
]


def run(kind):
    if kind == "pg":
        cmd = ["node", "--import", "tsx", "--test", "--test-concurrency=1",
               "--test-timeout=300000", PG]
    else:
        cmd = ["node", "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test", UNIT]
    return subprocess.run(cmd, cwd=REPO, env=ENV, capture_output=True, text=True).returncode


missed = []
print("== S7b mutation checks ==")
for label, path, old, new, kind in MUTATIONS:
    src = path.read_text()
    if old not in src:
        print(f"  NO-OP    {label}  <-- anchor not found (already changed?)")
        missed.append(label)
        continue
    backup = src
    path.write_text(src.replace(old, new, 1))
    try:
        if path.read_text() == backup:
            print(f"  NO-OP    {label}")
            missed.append(label)
            continue
        code = run(kind)
        if code != 0:
            print(f"  CAUGHT   {label}  [{kind}]")
        else:
            print(f"  MISSED   {label}  [{kind}]  <-- tests still passed")
            missed.append(label)
    finally:
        path.write_text(backup)

print()
print("missed:", len(missed))
for m in missed:
    print("   -", m)
sys.exit(1 if missed else 0)
