import assert from "node:assert/strict";
import test, { type TestContext, type TestOptions } from "node:test";

// Keep the names checked at module load identical to the names registered with Node.
export function mutationLane(expectedParents: number) {
  const parents: string[] = [];
  const registrations: (() => Promise<void>)[] = [];
  return {
    parents,
    expectedParents,
    register() { for (const register of registrations) void register(); },
    test(name: string, expectedProbes: number, options: TestOptions,
      run: (t: TestContext, probe: () => void) => Promise<void>) {
      parents.push(name);
      registrations.push(() => test(name, options, async t => {
        let selected = 0;
        await run(t, () => { selected++; });
        assert.equal(selected, expectedProbes, `${name}: executed expected probe count`);
        console.log(`Mutation lane: selected=${selected}/${expectedProbes} parent=${name}`);
      }));
    },
  };
}

export function assertMutationLaneSelection(lanes: ReturnType<typeof mutationLane>[]) {
  for (const lane of lanes) {
    assert.equal(lane.parents.length, lane.expectedParents, "mutation lane registers every expected parent");
    assert.equal(new Set(lane.parents).size, lane.expectedParents, "mutation lane parent names are unique");
  }
  // Node exits green when a name pattern matches no parent. Refuse this before
  // Node can skip the parent, and refuse partial selections of a grouped lane.
  const pattern = process.execArgv.find(arg => arg.startsWith("--test-name-pattern="))?.slice("--test-name-pattern=".length);
  if (pattern !== undefined) {
    const selected = lanes.map(lane => lane.parents.filter(name => new RegExp(pattern).test(name)).length);
    assert.equal(selected.filter(count => count > 0).length, 1, "mutation lane must select exactly one registered lane");
    for (let index = 0; index < lanes.length; index++) {
      if (selected[index]) assert.equal(selected[index], lanes[index]!.expectedParents, "mutation lane must select every expected parent");
    }
  }
  for (const lane of lanes) lane.register();
}
