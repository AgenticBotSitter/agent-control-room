// Capture the owner website's real pages as PNGs, for the visual-change PRs.
//
//   CONTROL_ROOM_SCREENSHOT_ORIGIN=http://127.0.0.1:3217 \
//   CONTROL_ROOM_SCREENSHOT_ROOT=/absolute/path/to/rehearsal-root \
//     node scripts/owner-page-screenshots.mjs <outputDir> [light|dark]
//
// Every capture is a real signed-in page from the running local stack, using the
// same owner-code endpoint and the same saved records the owner sees. Nothing is
// stubbed: a page that cannot be read is screenshotted as it actually renders,
// which is the point — a screenshot of a broken page is evidence, not a defect to
// hide.
//
// The script also writes a small JSON sidecar per image recording the computed
// background and any horizontal overflow, so a PR caption cannot claim a theme
// the page did not actually paint.
//
// colourScheme is "dark" or "light" and selects the emulated OS preference, which
// is the only thing that changes between the two runs. Both widths are always
// captured because the owner website is used on a phone.
//
// It is NOT wired into CI. The workflow step that used to call it referenced a
// shell variable from an earlier step, so it expanded empty and skipped every
// run, and its teardown stopped the app host rather than the database cluster.
// Photographing a page needs a stack that outlives the journey helper, which
// tears each one down; that is a rehearsal-harness change and wants the review
// docs/ci-budget-security-review.md calls for. Run this locally against a
// rehearsal root while reviewing a visual change.
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDir = process.argv[2] ?? "test-results/owner-screenshots";
const colorScheme = process.argv[3] === "dark" ? "dark" : "light";
const origin = process.env.CONTROL_ROOM_SCREENSHOT_ORIGIN;
const protectedRoot = process.env.CONTROL_ROOM_SCREENSHOT_ROOT;

if (!origin || !protectedRoot) {
  process.stderr.write("CONTROL_ROOM_SCREENSHOT_ORIGIN and CONTROL_ROOM_SCREENSHOT_ROOT are required\n");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
// The variable is the rehearsal ROOT (the parent that holds pg/, first-owner-*.json
// and protected/); the owner code lives under its protected/config directory.
const ownerCode = (await readFile(join(protectedRoot, "protected/config/owner-sign-in.txt"), "utf8")).trim();

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme,
});
const page = await context.newPage();

const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone390", width: 390, height: 844 },
];

async function capture(route, viewport) {
  const current = new URL(page.url());
  if (current.origin !== origin || current.pathname !== route.path)
    throw new Error(`screenshot_route_mismatch:${route.slug}:${current.pathname}`);
  const file = join(outputDir, `${route.slug}-${viewport.name}-${colorScheme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const painted = await page.evaluate(() => ({
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    background: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    overflowsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  await writeFile(`${file}.json`, `${JSON.stringify({ route: route.path, ...painted }, null, 2)}\n`);
  process.stdout.write(`${route.slug} ${viewport.name} ${colorScheme}: bg=${painted.background} overflow=${painted.overflowsHorizontally}\n`);
}

// Capture the unauthenticated surface before entering or submitting the owner
// code. Both widths are evidence for /session, not for its redirect target.
const signInRoute = { slug: "sign-in", path: "/session" };
await page.goto(`${origin}${signInRoute.path}`);
for (const viewport of viewports) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await capture(signInRoute, viewport);
}

// Sign in through the public sign-in form, exactly as the owner does.
await page.getByLabel("Owner code").fill(ownerCode);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL("**/projects");

// The protected pages the owner actually uses. Each is listed by its route.
const routes = [
  { slug: "home", path: "/" },
  { slug: "projects", path: "/projects" },
  { slug: "workers", path: "/workers" },
  { slug: "needs-attention", path: "/needs-me" },
];

for (const viewport of viewports) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  for (const route of routes) {
    await page.goto(`${origin}${route.path}`, { waitUntil: "networkidle" });
    // These pages run bounded client-side reads, so `networkidle` fires while
    // they are still showing their loading state. A fixed wait is a guess, and a
    // guess produced screenshots of "Loading projects..." that proved nothing
    // about the change under review. So: wait for the shared loading state to
    // clear. Matching on the word "Loading" does not work — it appears in
    // permanent copy such as "Loading a project from Idea Lab" — so this keys on
    // the class the shared LoadingState renders, with a bounded fallback so a
    // page that never loads is still captured. A screenshot of a stuck page is
    // evidence, not a reason to hang.
    await page.waitForFunction(() => !document.querySelector(".private-state-loading"), null,
      { timeout: 20_000 }).catch(() => { process.stdout.write(`${route.slug} ${viewport.name}: still loading after 20s\n`); });
    await page.waitForTimeout(500);
    await capture(route, viewport);
  }
}

await browser.close();
