import { sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { newsStoryInputSchemaV1, newsStorySchemaV1 } from "./schemas";
import { NEWS_CONTRACT_V1, type NewsStoryV1 } from "./types";

function unsigned(story: NewsStoryV1): Omit<NewsStoryV1, "storyDigest"> {
  const { storyDigest: _storyDigest, ...material } = story;
  void _storyDigest;
  return material;
}

export function buildNewsStoryV1(inputValue: unknown): NewsStoryV1 {
  const input = parseExactProjectWorkspaceV1(newsStoryInputSchemaV1, inputValue);
  const material: Omit<NewsStoryV1, "storyDigest"> = {
    contractVersion: NEWS_CONTRACT_V1,
    ...input,
    canonicalHost: new URL(input.canonicalUrl).hostname,
    containsRawNewsletterBody: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactProjectWorkspaceV1(newsStorySchemaV1, { ...material, storyDigest: sha256Digest(material) }) as NewsStoryV1;
}

export function parseNewsStoryV1(value: unknown): NewsStoryV1 {
  const story = parseExactProjectWorkspaceV1(newsStorySchemaV1, value) as NewsStoryV1;
  if (sha256Digest(unsigned(story)) !== story.storyDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return story;
}
