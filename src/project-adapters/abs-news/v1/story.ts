import { sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { absNewsStoryInputSchemaV1, absNewsStorySchemaV1 } from "./schemas";
import { ABS_NEWS_CONTRACT_V1, type AbsNewsStoryV1 } from "./types";

function unsigned(story: AbsNewsStoryV1): Omit<AbsNewsStoryV1, "storyDigest"> {
  const { storyDigest: _storyDigest, ...material } = story;
  void _storyDigest;
  return material;
}

export function buildAbsNewsStoryV1(inputValue: unknown): AbsNewsStoryV1 {
  const input = parseExactProjectWorkspaceV1(absNewsStoryInputSchemaV1, inputValue);
  const material: Omit<AbsNewsStoryV1, "storyDigest"> = {
    contractVersion: ABS_NEWS_CONTRACT_V1,
    ...input,
    canonicalHost: new URL(input.canonicalUrl).hostname,
    containsRawNewsletterBody: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactProjectWorkspaceV1(absNewsStorySchemaV1, { ...material, storyDigest: sha256Digest(material) }) as AbsNewsStoryV1;
}

export function parseAbsNewsStoryV1(value: unknown): AbsNewsStoryV1 {
  const story = parseExactProjectWorkspaceV1(absNewsStorySchemaV1, value) as AbsNewsStoryV1;
  if (sha256Digest(unsigned(story)) !== story.storyDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return story;
}
