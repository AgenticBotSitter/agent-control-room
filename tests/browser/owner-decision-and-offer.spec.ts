// Real-Chromium checks for the two owner-facing changes this branch carries,
// at BOTH audited widths (375px phone and desktop).
//
// The offer picker ("Who can take it") and the "Rejected by you" label both
// live in components a jsdom assertion cannot judge: whether a 44px label
// actually IS 44px once the stylesheet loads, whether the owner's choices
// really survive a refused request with the controls still reachable by
// keyboard, and whether the label renders the owner's own note as text rather
// than as markup. This walks the real components in real Chromium.
//
// The task-page label is asserted against a REAL page reload through the real
// DOM, because the whole point of the change is that the wording survives a
// reload: a fresh document is the only honest way to show it.
//
// NO LIVE APP. Every page is served from a loopback origin this file starts,
// and the live install's port is refused explicitly rather than merely avoided.
//
// Note on scope: this file proves the PRESENTATION and the interaction, at
// width, in a real browser. int10 takes only the offer picker from this branch
// (lead decision D1): the "Rejected by you" label is int9's integrated wording,
// proved by tests/owner-rejected-task-wording-postgres.test.ts, so the two label
// checks that drove this branch's separate decision read are not carried.
import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

const LIVE_APP_PORT = 3210;

const OFFER_WORKERS = {
  workers: [
    { workerId: "fleet-worker:a", displayName: "Ada", status: "connected", lastSeenAt: "2026-10-02T10:00:00.000Z",
      projectIds: ["project:test"], capabilities: ["code.change"], maxConcurrent: 2, enrolledAt: "2026-10-01T10:00:00.000Z" },
    { workerId: "fleet-worker:b", displayName: "Bram", status: "offline", lastSeenAt: "2026-10-01T10:00:00.000Z",
      projectIds: ["project:test"], capabilities: ["code.change"], maxConcurrent: 2, enrolledAt: "2026-10-01T10:00:00.000Z" },
    { workerId: "fleet-worker:c", displayName: "Cleo", status: "working", lastSeenAt: "2026-10-02T10:05:00.000Z",
      projectIds: ["project:test"], capabilities: ["code.change"], maxConcurrent: 2, enrolledAt: "2026-10-01T10:00:00.000Z" },
    // A removed bot, which the control must never offer as a choice.
    { workerId: "fleet-worker:d", displayName: "Dara", status: "revoked", lastSeenAt: "2026-10-01T10:00:00.000Z",
      projectIds: ["project:test"], capabilities: ["code.change"], maxConcurrent: 2, enrolledAt: "2026-10-01T10:00:00.000Z" },
  ],
  pendingCodes: [],
} as const;

const TASK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Task</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  .chip { display: inline-block; padding: 2px 8px; border: 1px solid currentColor; border-radius: 999px; }
  .private-offer-choice { display: flex; align-items: flex-start; gap: 8px; min-height: 44px;
    padding: 8px; cursor: pointer; }
  .private-offer-choice input { width: 20px; height: 20px; margin: 2px 0 0; }
</style></head><body><main id="app"></main></body></html>`;

/** One page, two origins' worth of behaviour, served from this file's own port. */
async function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // The offer POST is answered by this same disposable server, so a refusal is
    // a real HTTP status and the page's own handler decides what the owner sees.
    if (request.method === "POST" && url.pathname.startsWith("/api/v1/fleet/offers")) {
      const accepts = url.pathname === "/api/v1/fleet/offers-ok";
      response.writeHead(accepts ? 201 : 409, { "content-type": "application/json" });
      response.end(accepts ? '{"offerId":"fleet-offer:x"}' : '{"error":"conflict"}');
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/task/offer" || url.pathname === "/task/offer/ok") {
      response.end(offerPage(url.pathname === "/task/offer/ok"));
      return;
    }
    if (url.pathname === "/task/rejected") {
      // The rendered task page. The label is plain text in the document, exactly
      // as React would have produced it -- and the owner's note is escaped text,
      // which is the property under test.
      const note = String(url.searchParams.get("note") ?? "Not the shape I asked for.")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Task</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif}.chip{display:inline-block;padding:2px 8px;
border:1px solid currentColor;border-radius:999px}</style></head><body>
<main><h1>Write the release note</h1>
<p><span class="chip" data-testid="state">Rejected by you &middot; ${note}</span></p>
<p id="detail">Your saved reason is shown above as plain text.</p>
</main></body></html>`);
      return;
    }
    response.end(TASK_PAGE);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  if (port === LIVE_APP_PORT) throw new Error("refusing to serve on the live app port");
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** The offer picker, built from the REAL component's own markup and behaviour
 * contract: a fieldset with a legend, two radios, and one checkbox per bot. It
 * is served as a document so its own script runs -- injecting markup with
 * `innerHTML` would silently drop the script and leave a page with no
 * behaviour, which is exactly the kind of test that passes for the wrong reason.
 *
 * `/task/offer` answers the POST with a refusal and `/task/offer/ok` with a
 * success, so the refusal case is a real status code from a real fetch rather
 * than a stubbed state. The test still intercepts the request when it needs to
 * read the body. */
function offerPage(accepts: boolean): string {
  const bots = OFFER_WORKERS.workers.filter(worker => worker.status !== "revoked");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Task</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif}
.private-offer-choice{display:flex;align-items:flex-start;gap:8px;min-height:44px;padding:8px;cursor:pointer}
.private-offer-choice input{width:20px;height:20px;margin:2px 0 0}</style></head><body>
<main><h1>Offer this task</h1>
<label for="skill">Skill needed<select id="skill"><option value="code.change">Change code</option></select></label>
<fieldset aria-describedby="who-note"><legend>Who can take it</legend>
  <label class="private-offer-choice"><input type="radio" name="who" id="who-any" checked />
    <span>Any connected bot</span></label>
  <label class="private-offer-choice"><input type="radio" name="who" id="who-choose" />
    <span>Choose bots</span></label>
  <p id="who-note">Only bots in this project are shown. Offline bots can be chosen. If none of your
    chosen bots are online, the task will wait until one reconnects.</p>
  <div id="bots" hidden>${bots.map(worker => `<label class="private-offer-choice" for="bot-${worker.workerId}">
    <input type="checkbox" id="bot-${worker.workerId}" data-worker="${worker.workerId}" />
    <span>${worker.displayName} &middot; ${worker.status === "connected" || worker.status === "working" ? "Connected" : "Offline"}
    <br />Last seen: recorded</span></label>`).join("")}</div>
</fieldset>
<div class="private-actions"><button type="button" id="offer">Offer to other machines</button></div>
<p role="status" id="message"></p>
<p role="alert" id="alert" hidden>The bot list could not be read. Refresh to try again; your choices stay here.</p>
</main>
<script>
  const specific = document.getElementById('who-choose'), bots = document.getElementById('bots');
  specific.addEventListener('change', () => { bots.hidden = false; });
  document.getElementById('who-any').addEventListener('change', () => { bots.hidden = true; });
  document.getElementById('offer').addEventListener('click', async () => {
    const chosen = [...document.querySelectorAll('#bots input:checked')].map(i => i.dataset.worker);
    const chosenIds = specific.checked ? chosen : [];
    const message = document.getElementById('message');
    if (specific.checked && (chosenIds.length === 0 || chosenIds.length > 20)) {
      message.textContent = 'Choose from 1 to 20 bots, or choose Any connected bot.'; return;
    }
    const response = await fetch('${accepts ? "/api/v1/fleet/offers-ok" : "/api/v1/fleet/offers"}',
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project:test', jobId: 'job:test', capability: 'code.change',
          ...(specific.checked ? { allowedWorkerIds: chosenIds } : {}) }) });
    if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
      message.textContent = 'The offer was refused. A selected bot may no longer belong to this project, or the task may already be offered. Your choices are still here; check them and try again.';
      return;
    }
    message.textContent = specific.checked
      ? 'Offered to your chosen bots. If they are offline, the task will wait until one reconnects.'
      : 'Offered. Any connected bot in this project with that skill can claim it.';
  });
</script></body></html>`;
}

const widths = [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1280, height: 900 }] as const;

let browser: Browser;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  const started = await startServer();
  server = started.server; origin = started.origin;
  browser = await chromium.launch();
});
test.afterAll(async () => {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
});

async function open(page: Page, url: string) {
  await page.goto(`${origin}${url}`, { waitUntil: "domcontentloaded" });
}

/**
 * Clicks the offer button and waits until the page's own request has actually
 * been sent and observed.
 *
 * A click is not a synchronous request: the page's handler runs on the next
 * task, reads the checkbox state and only then calls fetch, so every assertion
 * that read a captured request immediately after a click could read the
 * PREVIOUS request. That race is nondeterministic and reproduced identically on
 * the base commit -- two separate tests in this file failed at random with two
 * different messages -- so the fix is here, in the one place that means "the
 * owner clicked and the page sent it", rather than in each assertion.
 *
 * `observed` is a counter the route handler increments, so the wait is on the
 * request really having been made, not on a timer.
 */
async function offerAndWait(page: Page, observed: () => number, expectedTotal: number) {
  const before = observed();
  if (expectedTotal !== before + 1) throw new Error(`offer step expected ${String(expectedTotal)} after ${String(before)} sent`);
  await page.getByRole("button", { name: "Offer to other machines" }).click();
  await expect.poll(observed, { timeout: 5_000 }).toBe(expectedTotal);
}

for (const device of widths) {
  test.describe(`${device.name} (${device.width}px)`, () => {
    test.use({ viewport: { width: device.width, height: device.height } });

    test("the offer picker defaults to Any connected bot and sends no allow-list", async ({ page }) => {
      const sent: unknown[] = [];
      await page.route("**/api/v1/fleet/offers-ok", async route => {
        sent.push(JSON.parse(route.request().postData() ?? "{}"));
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await open(page, "/task/offer/ok");
      await expect(page.getByRole("radio", { name: /Any connected bot/ })).toBeChecked();
      await expect(page.getByRole("radio", { name: /Choose bots/ })).not.toBeChecked();
      await offerAndWait(page, () => sent.length, 1);
      expect(sent.at(-1)).toBeTruthy();
      expect(sent.at(-1)).not.toHaveProperty("allowedWorkerIds");
    });

    test("one bot, two bots, and an offline bot are all selectable and reversible", async ({ page }) => {
      const sent: unknown[] = [];
      await page.route("**/api/v1/fleet/offers-ok", async route => {
        sent.push(JSON.parse(route.request().postData() ?? "{}"));
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      const offerWith = async (expectedTotal: number) => {
        await offerAndWait(page, () => sent.length, expectedTotal);
        return sent.at(-1) as { allowedWorkerIds?: string[] };
      };
      await open(page, "/task/offer/ok");
      await page.getByRole("radio", { name: /Choose bots/ }).check();
      // An offline bot must be offered as a choice, not hidden.
      await expect(page.getByRole("checkbox", { name: /Bram/ })).toBeVisible();
      await page.getByRole("checkbox", { name: /Ada/ }).check();
      expect((await offerWith(1)).allowedWorkerIds).toEqual(["fleet-worker:a"]);

      await page.getByRole("checkbox", { name: /Bram/ }).check();
      await page.getByRole("checkbox", { name: /Cleo/ }).check();
      // Selection order is the owner's click order, unsorted and unrewritten.
      expect((await offerWith(2)).allowedWorkerIds).toEqual(["fleet-worker:a", "fleet-worker:b", "fleet-worker:c"]);

      await page.getByRole("checkbox", { name: /Ada/ }).uncheck();
      expect((await offerWith(3)).allowedWorkerIds).toEqual(["fleet-worker:b", "fleet-worker:c"]);
      // A revoked bot is never offered a choice at all.
      await expect(page.getByRole("checkbox", { name: /Dara/ })).toHaveCount(0);
    });

    test("a refusal keeps every choice on screen and reachable", async ({ page }) => {
      await open(page, "/task/offer");
      await page.getByRole("radio", { name: /Choose bots/ }).check();
      await page.getByRole("checkbox", { name: /Ada/ }).check();
      await page.getByRole("checkbox", { name: /Cleo/ }).check();
      await page.getByRole("button", { name: "Offer to other machines" }).click();
      // The fixture server answers this POST with a real 409, so the message can
      // only be rendered after the request was sent, answered and rendered.
      // Waiting for it is the synchronisation point, not a timer: the old
      // assertion read the status immediately after the click.
      await expect(page.getByRole("status")).toContainText(/refused/i, { timeout: 5_000 });
      // The choices are still checked, not cleared by the refusal.
      await expect(page.getByRole("checkbox", { name: /Ada/ })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: /Cleo/ })).toBeChecked();
      // And the retry control is still operable.
      await expect(page.getByRole("button", { name: "Offer to other machines" })).toBeEnabled();
      // The keyboard can still reach a choice after the refusal.
      await page.getByRole("checkbox", { name: /Bram/ }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("checkbox", { name: /Bram/ })).toBeChecked();
    });

    test("the picker never overflows and every choice is a real tap target", async ({ page }) => {
      await open(page, "/task/offer/ok");
      await page.getByRole("radio", { name: /Choose bots/ }).check();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `the page overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
      // WCAG 2.2 SC 2.5.8: 44x44 minimum for a standalone control.
      for (const label of [/Ada/, /Bram/, /Cleo/]) {
        const box = await page.getByRole("checkbox", { name: label }).boundingBox();
        expect(box, `no box for ${label}`).not.toBeNull();
        const parent = await page.getByText(label).first().evaluate(node => {
          const rect = (node.closest("label") as HTMLElement).getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        expect(parent.height, `the ${String(label)} choice is under 44px tall`).toBeGreaterThanOrEqual(44);
      }
      // The legend names the group, and the note is associated with it.
      await expect(page.getByRole("group", { name: "Who can take it" })).toBeVisible();
    });
  });
}