import { createHash } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

export const articleExtractionLimits = Object.freeze({ inputBytes: 524288, outputBytes: 131072, maxElements: 20000 });

/** Parse supplied bytes only. Must run behind an isolated bounded execution
 * boundary before use from a live HTTP route; this function alone cannot enforce
 * a wall-clock deadline. No fetching, scripts, external resources or persistence. */
export function extractArticleText(html, sourceUrl) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > articleExtractionLimits.inputBytes)
    return { status: "input_rejected" };
  let url;
  try { url = new URL(sourceUrl); } catch { return { status: "input_rejected" }; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    return { status: "input_rejected" };
  const sourceHash = `sha256:${createHash("sha256").update(html).digest("hex")}`;
  let dom;
  try {
    // Default jsdom leaves scripts and subresource loading disabled. Do not set
    // runScripts/resources or attach a browser/network resource loader.
    // A disconnected console prevents parser errors from copying raw article
    // markup/styles into the server's stderr outside the output-size boundary.
    dom = new JSDOM(html, { url: url.href, contentType: "text/html", virtualConsole: new VirtualConsole() });
    const article = new Readability(dom.window.document, { maxElemsToParse: articleExtractionLimits.maxElements }).parse();
    if (!article?.textContent?.trim()) return { status: "unavailable", sourceHash };
    const text = article.textContent.trim();
    if (Buffer.byteLength(text, "utf8") > articleExtractionLimits.outputBytes)
      return { status: "output_rejected", sourceHash };
    return { status: "extracted", sourceUrl: url.href, sourceHash, text,
      extractor: "@mozilla/readability@0.6.0+jsdom@26.1.0" };
  } catch { return { status: "unavailable", sourceHash }; }
  finally { dom?.window.close(); }
}
