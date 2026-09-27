// Capture the owner website's real pages as PNGs, for the visual-change PRs.
//
//   node scripts/owner-page-screenshots.mjs <outputDir> [colourScheme]
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

// Sign in through the public sign-in form, exactly as the owner does.
await page.goto(`${origin}/session`);
await page.getByLabel("Owner code").fill(ownerCode);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL("**/projects");

const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone390", width: 390, height: 844 },
];

// The pages the owner actually uses. Each is listed by its route; the sign-in
// page is captured above as part of signing in.
const routes = [
  { slug: "home", path: "/" },
  { slug: "projects", path: "/projects" },
  { slug: "workers", path: "/workers" },
  { slug: "needs-attention", path: "/needs-me" },
];

await page.screenshot({ path: join(outputDir, `sign-in-${colorScheme}.png`), fullPage: true });

for (const viewport of viewports) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  for (const route of routes) {
    await page.goto(`${origin}${route.path}`, { waitUntil: "networkidle" });
    // These pages run bounded client reads; give them a moment to settle so the
    // capture shows the loaded state rather than the loading state.
    await page.waitForTimeout(1_500);
    const file = join(outputDir, `${route.slug}-${viewport.name}-${colorScheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const painted = await page.evaluate(() => ({
      prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      overflowsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    await writeFile(`${file}.json`, `${JSON.stringify(painted, null, 2)}\n`);
    process.stdout.write(`${route.slug} ${viewport.name} ${colorScheme}: bg=${painted.background} overflow=${painted.overflowsHorizontally}\n`);
  }
}

await browser.close();
