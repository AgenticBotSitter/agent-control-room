// Synthetic consumer of the real mutation-lane helper. The parent process in
// tests/check-test-lane-coverage.test.mjs describes the lanes in
// MUTATION_LANE_FIXTURE and asserts on this file's child exit.
import test from "node:test";
import { mutationLane, assertMutationLaneSelection } from "../../helpers/mutation-lane-selfcheck";

type Parent = { name: string; probes: number; expectedProbes: number };
type Lane = { expectedParents: number; enabled: boolean; parents: Parent[] };
const spec = JSON.parse(process.env.MUTATION_LANE_FIXTURE ?? "{\"lanes\":[]}") as { lanes: Lane[] };

test("fixture ordinary test", () => {});

const lanes = spec.lanes.map(({ expectedParents, enabled, parents }) => {
  const lane = mutationLane(expectedParents, { enabled });
  for (const parent of parents) lane.test(parent.name, parent.expectedProbes, {}, async (_t, probe) => {
    for (let index = 0; index < parent.probes; index++) probe();
  });
  return lane;
});
assertMutationLaneSelection(lanes);
