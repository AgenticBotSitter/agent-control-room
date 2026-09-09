import { z } from "zod";
import { sha256Digest } from "../../../security/digest";
import { parseAbsNewsStoryV1 } from "./story";
import { extractArticleBounded } from "./article-extraction-runtime.mjs";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import { absNewsCanonicalUrlSchemaV1 } from "./schemas";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceDigestSchemaV1 as digest } from "../../../project-workspace/v1";

const bindingSchema = z.object({ tenantId: id, workspaceId: id, projectId: id,
  storyId: id, storyDigest: digest }).strict();
const extractedSchema = z.object({ status: z.literal("extracted"), sourceUrl: absNewsCanonicalUrlSchemaV1,
  sourceHash: digest, text: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 131072),
  extractor: z.literal("@mozilla/readability@0.6.0+jsdom@26.1.0") }).strict();

/** Trusted composition, not HTTP authorization. Caller provides an authenticated
 * scoped store and the existing bounded public reader. No alternative fetcher,
 * execution receipt, task mutation or storage side effect is introduced here. */
export async function readNewsArticleDetail(bindingValue: unknown, ports: {
  getStory(storyId: string): Promise<unknown>;
  reader: { read(url: string, signal: AbortSignal): Promise<{ text: string; byteCount: number; contentType: string; endpointUrl: string }> };
  authority: AbsCurrentSourceAuthority;
}, signal: AbortSignal) {
  const binding = bindingSchema.parse(bindingValue);
  const current = captureAbsCurrentSourceAuthority(ports.authority);
  const checkStory = async () => {
    signal.throwIfAborted();
    const story = parseAbsNewsStoryV1(await ports.getStory(binding.storyId));
    for (const key of ["tenantId", "workspaceId", "projectId", "storyId", "storyDigest"] as const)
      if (story[key] !== binding[key]) throw new Error("news_article_source_changed");
    current(story.canonicalUrl); signal.throwIfAborted();
    return story;
  };
  const story = await checkStory();
  const body = await ports.reader.read(story.canonicalUrl, signal);
  await checkStory();
  if (body.endpointUrl !== story.canonicalUrl || body.contentType.split(";", 1)[0].trim().toLowerCase() !== "text/html"
    || typeof body.text !== "string" || body.byteCount !== Buffer.byteLength(body.text, "utf8") || body.byteCount > 524288)
    throw new Error("news_article_body_rejected");
  const result = await extractArticleBounded(body.text, story.canonicalUrl);
  await checkStory();
  if (result.status !== "extracted") return { ...binding, canonicalUrl: story.canonicalUrl,
    status: "unavailable" as const, reason: result.status };
  const extracted = extractedSchema.parse(result);
  if (extracted.sourceUrl !== story.canonicalUrl) throw new Error("news_article_source_changed");
  const detail = { ...binding, canonicalUrl: story.canonicalUrl, status: "extracted" as const,
    sourceHash: extracted.sourceHash, extractor: extracted.extractor, text: extracted.text };
  return { ...detail, detailDigest: sha256Digest(detail) };
}
