import { expect, type Locator, type Page, type Route } from "@playwright/test";

const reviewOptionsPath = /\/reviews\/[^/?#]+$/;

type DeferredReviewLoad = Readonly<{
  waitUntilHeld: () => Promise<void>;
  release: () => void;
  dispose: () => Promise<void>;
}>;

/**
 * Test-only load gate. It holds one options read until the page has rendered
 * its product loading marker, rather than pausing for an arbitrary duration.
 */
export async function deferNextOwnerReviewLoad(page: Page): Promise<DeferredReviewLoad> {
  let held = false, release!: () => void, markHeld!: () => void, markFinished!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const heldOnce = new Promise<void>(resolve => { markHeld = resolve; });
  const finished = new Promise<void>(resolve => { markFinished = resolve; });
  const handler = async (route: Route) => {
    if (held || route.request().method() !== "GET" || !reviewOptionsPath.test(new URL(route.request().url()).pathname)) {
      await route.continue();
      return;
    }
    held = true;
    markHeld();
    try {
      await released;
      await route.continue();
    } finally { markFinished(); }
  };
  await page.route("**/reviews/**", handler);
  return Object.freeze({
    waitUntilHeld: () => heldOnce,
    release,
    dispose: async () => { release(); await finished; await page.unroute("**/reviews/**", handler); },
  });
}

export async function ownerReviewControlsWhenReady(page: Page): Promise<Readonly<{
  panel: Locator; attestation: Locator; accept: Locator;
}>> {
  const panel = page.getByRole("region", { name: "Owner quality decision" });
  await expect(panel).toHaveAttribute("data-state", "ready");
  await expect(panel.getByRole("heading", { name: "Review this exact result", exact: true })).toBeVisible();
  const attestation = panel.getByLabel("I read it and it’s correct");
  const accept = panel.getByRole("button", { name: "Accept", exact: true });
  await expect(attestation).toBeEnabled();
  return Object.freeze({ panel, attestation, accept });
}

export async function requestChangesControlWhenReady(page: Page, feedback: string): Promise<Locator> {
  const { panel } = await ownerReviewControlsWhenReady(page);
  const changes = panel.getByLabel("Changes you want");
  const requestChanges = panel.getByRole("button", { name: "Request changes", exact: true });
  await expect(changes).toBeEnabled();
  await changes.fill(feedback);
  await expect(requestChanges).toBeEnabled();
  return requestChanges;
}

/** Opens a result while proving the owner-review panel exposes its loading state before it becomes ready. */
export async function openResultWithDeferredOwnerReview(page: Page): Promise<void> {
  const deferred = await deferNextOwnerReviewLoad(page);
  try {
    await page.getByRole("button", { name: "Read result" }).first().click();
    await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
    await deferred.waitUntilHeld();
    const loading = page.locator('[role="status"][data-state="loading"]');
    await expect(loading).toHaveText("Loading owner review…");
    deferred.release();
  } finally {
    deferred.release();
    await deferred.dispose();
  }
}
