import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public-site/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public-site/styles.css", import.meta.url), "utf8");
test("welcome page is independent, informational and contains no guessed destinations", () => {
  assert.deepEqual(readdirSync(new URL("../public-site", import.meta.url)).sort(), ["README.md", "index.html", "styles.css"]);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /There is no public download yet/);
  assert.match(html, /not a claim that every feature is ready/);
  assert.match(html, /not yet accepted/);
  assert.doesNotMatch(html, /<(?:script|form|iframe|img|video|audio|object|embed)\b/i);
  assert.doesNotMatch(html, /\b(?:src|action)=|\bon\w+=|https?:\/\//i);
  assert.doesNotMatch(css, /@import|url\s*\(/i);
  assert.match(html, /default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'/);
});
test("all local links resolve and sections have accessible headings", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
    if (href.startsWith("#")) assert.ok(ids.includes(href.slice(1)));
    else assert.equal(href, "styles.css");
  }
  for (const [, label] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(label));
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 40rem\)/);
});
