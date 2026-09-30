#!/bin/bash
# S7b self-test: mutation-test each ceiling comparison. Every mutation is applied
# with python, the real-login suite is run, and the file is restored afterwards.
# A mutation that leaves the suite GREEN is an untested guard: this script fails.
set -u
cd /Users/alastairfraser/work/acr-cook-s7b
SVC=src/pipelines/v1/advance-service.ts
PORT=58706
applied=0; caught=0

apply () { python3 -c '
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path); t = p.read_text()
if old not in t:
    print("    PATCH TARGET MISSING"); sys.exit(2)
p.write_text(t.replace(old, new, 1))
' "$@"; }

run () {
  S7B_PG_PORT=$PORT pnpm exec tsx --test --test-concurrency=1 tests/postgres-pipeline-caps.test.mjs > /tmp/s7b-mut.log 2>&1
  if [ $? -ne 0 ]; then
    echo "    CAUGHT"
    caught=$((caught+1))
  else
    echo "    *** NOT CAUGHT: suite still green ***"
  fi
}

mutate () { # name old new
  echo "--- $1"
  applied=$((applied+1))
  if apply "$SVC" "$2" "$3"; then run; else echo "    SKIPPED (target absent)"; fi
  git checkout -- "$SVC"
}

mutate "M1 runs_per_hour: > becomes >=" \
  "if (runsThisHour+1>runsPerHour) refuse(\"installation_runs_per_hour_exhausted\")" \
  "if (runsThisHour+1>=runsPerHour) refuse(\"installation_runs_per_hour_exhausted\")"

mutate "M2 agent_runs_per_day: > becomes >=" \
  "if (agentRunsToday+1>runsPerAgentPerDay) refuse(\"installation_agent_runs_per_day_exhausted\")" \
  "if (agentRunsToday+1>=runsPerAgentPerDay) refuse(\"installation_agent_runs_per_day_exhausted\")"

mutate "M3 agent_process_ceiling: > becomes >=" \
  "if (activeProcesses+1>agentCeiling) refuse(\"installation_agent_process_ceiling_reached\")" \
  "if (activeProcesses+1>=agentCeiling) refuse(\"installation_agent_process_ceiling_reached\")"

mutate "M4 db_cluster_ceiling: > becomes >=" \
  "if (dbClusters + 1 > clusterCeiling) refuse(\"installation_db_cluster_ceiling_reached\")" \
  "if (dbClusters + 1 >= clusterCeiling) refuse(\"installation_db_cluster_ceiling_reached\")"

mutate "M5 stage loop ceiling: > becomes >=" \
  "current.stageRounds > current.maxLoops" "current.stageRounds >= current.maxLoops"

mutate "M6 run loop ceiling: >= becomes >" \
  "nextRunTotal >= current.maxTotalLoops" "nextRunTotal > current.maxTotalLoops"

mutate "M7 unknown cost refuses again" \
  'const costKnown=nextCost.kind==="known";' \
  'const costKnown=nextCost.kind==="known";if(!costKnown)refuse("policy_cost_unknown");'

mutate "M8 loop stop records the refused round again (undo the clamp)" \
  "const loopIndex = Math.min(reachedLoopIndex, maxLoops);" "const loopIndex = reachedLoopIndex;"

mutate "M9 an unknown cluster count now passes" \
  "if (dbClusters === null) throw new PipelineAdvanceErrorV1(\"installation_cluster_count_unknown\")" \
  "if (dbClusters === null) { /* mutated: an unknown machine state now passes */ }"

echo
echo "mutations applied: $applied   caught: $caught"
if [ "$applied" -ne "$caught" ]; then echo "RESULT: FAIL - an untested guard remains"; exit 1; fi
echo "RESULT: PASS - every mutated guard was caught"
