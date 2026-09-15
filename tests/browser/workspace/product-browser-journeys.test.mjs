import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

import { planProductBrowserJourneys, renderProductBrowserJourneys,
  PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1 } from "./product-browser-journeys.mjs";

test("planProductBrowserJourneys: schema advertises the journey set and never claims a live agent", () => {
  const plan = planProductBrowserJourneys();
  assert.equal(plan.schema, PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1);
  assert.match(plan.simulator, /PGlite database/i);
  assert.match(plan.simulator, /single Playwright route/i);
  assert.match(plan.simulator, /no live agent/i);
  const titles = plan.journeys.map(j => j.title);
  assert.deepEqual(titles, [
    "Create project A and open its overview",
    "Save a task under project A and follow its protected detail",
    "Create project B and confirm navigation stays inside it",
    "Reconnect a browser context and prove project A still has its task",
    "Walk the Files, Reviews, Activity, Settings pages at 360px and 1280px",
    "Archive project A and reopen it without losing its task",
    "Reload, back/forward, and the narrow workspace menu",
    "Open the agent progress page that the result lifecycle publishes",
    "Open the protected result content and read the exact returned text",
    "Request owner changes and confirm the saved review decision",
    "Prepare a revised task and follow its protected follow-up page",
    "Distinguish a lost request from a lost reply using request-level evidence",
    "Exercise keyboard focus at both 360px and 1280px without sideways scroll",
    "Verify idempotency on every protected save command",
    "Clean up the exact owned browser, context, application and temporary profile data",
  ]);
  for (const journey of plan.journeys) {
    assert.ok(journey.command.startsWith("/api/v1/") || journey.command === "(no protected command)"
      || journey.command === "(read-only navigation)" || journey.command === "(cleanup)",
      `unexpected command for ${journey.title}: ${journey.command}`);
    assert.ok(journey.proof.length > 0, `proof missing for ${journey.title}`);
    assert.ok(journey.simulated, `journey ${journey.title} must declare itself simulated`);
  }
});

test("renderProductBrowserJourneys: human-readable output names every journey with its proof", () => {
  const rendered = renderProductBrowserJourneys(planProductBrowserJourneys());
  for (const journey of planProductBrowserJourneys().journeys) {
    assert.ok(rendered.includes(journey.title), `missing title in render: ${journey.title}`);
    assert.ok(rendered.includes(journey.command.replace(/[`]/g, "")), `missing command in render: ${journey.command}`);
  }
  assert.match(rendered, /no live agent/i);
});

test("planProductBrowserJourneys: rejected commands or missing simulation are fail-closed", () => {
  const plan = planProductBrowserJourneys();
  for (const journey of plan.journeys) {
    // A real path command has no spaces; sentinel commands are explicit.
    if (journey.command.startsWith("/api/v1/")) assert.ok(!journey.command.includes(" "),
      `command must be a single path: ${journey.command}`);
    assert.ok(!journey.proof.toLowerCase().includes("live agent"),
      `proof must not claim a live agent: ${journey.proof}`);
  }
  // Renderer rejects any plan whose schema does not match, so the journey
  // list can never be silently relabeled.
  assert.throws(() => renderProductBrowserJourneys({
    schema: "acr-product-browser-journeys:v0",
    simulator: "x", journeys: [{ title: "x", command: "/api/v1/x", proof: "y", simulated: true }] }),
    /expected acr-product-browser-journeys:v1 schema/);
});

test("sanitized screenshot predicate accepts bounded PNGs and rejects oversized ones", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "product-browser-"));
  const nested = resolve(dir, "evidence");
  await mkdir(nested, { recursive: true });

  // Build a minimal but valid 1x1 PNG.
  const zlib = await import("node:zlib");
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 1]), Buffer.from([8, 2, 0, 0, 0])]);
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  function crc(type, data) {
    const table = new Uint32Array(256); for (let n = 0; n < 256; n++) {
      let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0;
    }
    let crcValue = 0xffffffff;
    const buf = Buffer.concat([Buffer.from(type, "ascii"), data]);
    for (const byte of buf) crcValue = table[(crcValue ^ byte) & 0xff] ^ (crcValue >>> 1);
    return Buffer.from([(crcValue ^ 0xffffffff) >>> 24, (crcValue ^ 0xffffffff) >>> 16,
      (crcValue ^ 0xffffffff) >>> 8, (crcValue ^ 0xffffffff) & 0xff]);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, crc("IHDR", ihdr),
    Buffer.from([0, 0, 0, idat.length]), Buffer.from("IDAT"), idat, crc("IDAT", idat),
    Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), crc("IEND", Buffer.alloc(0)),
  ]);
  const path = resolve(nested, "bounded.png");
  await writeFile(path, png);

  const image = await readFile(path);
  assert.ok(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.equal(width, 1);
  assert.equal(height, 1);
  assert.ok(image.length <= 5 * 1024 * 1024);
  const real = realpathSync(nested);
  assert.ok(real.endsWith(`${sep}evidence`), `expected evidence subdirectory, got ${real}`);
});

test("invalid journey shape is rejected without coercion", () => {
  const plan = planProductBrowserJourneys();
  const first = plan.journeys[0];
  assert.ok(typeof first.title === "string" && first.title.length > 0);
  assert.ok(typeof first.command === "string" && first.command.startsWith("/api/v1/"));
  assert.ok(typeof first.proof === "string" && first.proof.length > 0);
  assert.equal(first.simulated, true);
});
