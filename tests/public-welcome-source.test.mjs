import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public-site/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public-site/styles.css", import.meta.url), "utf8");
test("welcome page is independent, informational and contains no guessed destinations", () => {
  assert.deepEqual(readdirSync(new URL("../public-site", import.meta.url)).sort(), ["DEPLOYMENT.md", "README.md", "index.html", "styles.css"]);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /Pre-alpha source is available/);
  assert.match(html, /not a production-ready system/);
  assert.doesNotMatch(html, /no public download yet|source release in preparation/i);
  assert.match(html, /agree on an issue with the maintainer before beginning work/);
  assert.match(html, /not a claim that every feature is ready/);
  assert.match(html, /not yet accepted/);
  assert.doesNotMatch(html, /<(?:script|form|iframe|img|video|audio|object|embed)\b/i);
  assert.doesNotMatch(html, /\b(?:src|action)=|\bon\w+=|dash\.cloudflare\.com/i);
  assert.doesNotMatch(css, /@import|url\s*\(/i);
  assert.match(html, /default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'/);
});
test("all local links resolve and sections have accessible headings", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
    if (href.startsWith("#")) assert.ok(ids.includes(href.slice(1)));
    else assert.ok(["styles.css", "mailto:Alastair@agenticbotsitter.com",
      "https://github.com/AgenticBotSitter/agent-control-room",
      "https://agenticbotsitter.com"].includes(href));
  }
  for (const [, label] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(label));
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 40rem\)/);
});

test("confirmed project contact is consistent without adding mail forms or credentials", () => {
  const address = "Alastair@agenticbotsitter.com";
  assert.ok(html.includes(`href="mailto:${address}">${address}</a>`));
  for (const path of ["public-site/README.md", "public-site/DEPLOYMENT.md",
    "docs/PUBLIC_PROJECT_BRIEF_DRAFT.md", "docs/PUBLIC_CONTRIBUTOR_GUIDE_DRAFT.md"]) {
    assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").includes(address), path);
  }
  assert.equal([...html.matchAll(/href="mailto:/g)].length, 1);
});

test("deployment handoff uses the owner-confirmed xyz domain without the stale domain question", () => {
  for (const path of ["public-site/DEPLOYMENT.md", "public-site/README.md",
    "docs/WEBSITE_REPOSITORY_HANDOFF.md", "docs/PUBLIC_LAUNCH_SETUP.md", "docs/PUBLIC_WEBSITE_COPY_DRAFT.md"]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(text.includes("agentcontrolroom.xyz"), path);
    assert.doesNotMatch(text, /AgentControlRoom\.com|Confirm which is owned|neither is a default deployment target/i);
  }
});
