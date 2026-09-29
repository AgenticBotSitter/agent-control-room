import assert from "node:assert/strict";
import test from "node:test";
import { deferNextOwnerReviewLoad } from "./owner-review-readiness";

function fakePage() {
  let handler: ((route: any) => Promise<void>) | undefined;
  let unrouted = false;
  return {
    page: {
      route: async (_pattern: string, next: (route: any) => Promise<void>) => { handler = next; },
      unroute: async (_pattern: string, next: (route: any) => Promise<void>) => {
        assert.equal(next, handler);
        unrouted = true;
      },
    } as any,
    get handler() { return handler; },
    get unrouted() { return unrouted; },
  };
}

function requestRoute(url: string) {
  return {
    request: () => ({ method: () => "GET", url: () => url }),
    continue: async () => {},
  };
}

test("dispose returns when no review request was intercepted", async () => {
  const fixture = fakePage();
  const deferred = await deferNextOwnerReviewLoad(fixture.page);
  const started = Date.now();
  await deferred.dispose();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(fixture.unrouted, true);
});

test("holds the concrete review endpoint with query strings and trailing slashes", async () => {
  for (const url of [
    "https://example.test/api/v1/projects/project/tasks/job/results/artifact/reviews/target",
    "https://example.test/api/v1/projects/project/tasks/job/results/artifact/reviews/target?draft=1",
    "https://example.test/api/v1/projects/project/tasks/job/results/artifact/reviews/target/",
    "https://example.test/api/v1/projects/project/tasks/job/results/artifact/reviews/target/?draft=1",
  ]) {
    const fixture = fakePage();
    const deferred = await deferNextOwnerReviewLoad(fixture.page);
    const request = fixture.handler!(requestRoute(url));
    await deferred.waitUntilHeld();
    deferred.release();
    await request;
    await deferred.dispose();
  }
});
