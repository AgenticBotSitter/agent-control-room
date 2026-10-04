import { z } from "zod";
import { portableUtf8ByteLengthV1 } from "../../security/inert-portable-input";
import {
  parseProjectPackV1,
  previewProjectPackV1,
  PROJECT_PACK_SCHEMA_V1,
  PROJECT_PACK_MAX_BYTES_V1,
  type ProjectPackPreviewV1,
  type ProjectPackV1,
} from "./project-pack";

/** Browser-safe entry point. Parsing never installs or depends on host globals. */
export function withParserByteLengthV1<T>(body: () => T): T {
  return body();
}

/** Raw text accepted from the local file/paste surface, before parsing. */
export interface RawPackInputV1 {
  readonly rawText: string;
}

export type ProjectPackBrowseOutcomeV1 =
  | { readonly status: "ready"; readonly pack: Readonly<ProjectPackV1>; readonly preview: Readonly<ProjectPackPreviewV1> }
  | { readonly status: "refused"; readonly reason: string };

export interface ProjectPackLocalConfigurationV1 {
  readonly ideaLab: boolean;
  readonly news: boolean;
  readonly sessionObservations: boolean;
}

/** Human-readable text for every canonical refusal reason. Never opaque. */
export function refusalTextV1(reason: string): string {
  const known: Record<string, string> = {
    project_pack_malformed: "The input is not a project pack object (expected a JSON object).",
    project_pack_input_oversized: "The input is larger than the 65536-byte pack ceiling.",
    project_pack_unknown_version: "Unknown pack schema version. Only control-room.project-pack/v1 is supported.",
    project_pack_prototype_pollution_key: "The input contains forbidden keys (__proto__/constructor/prototype).",
    project_pack_input_too_deep: "The input nests more than the allowed depth.",
    project_pack_duplicate_module: "The pack lists the same module more than once.",
    project_pack_non_canonical_module_order: "The pack lists modules in a non-canonical order.",
    project_pack_unknown_module: "The pack lists a module that is not part of this product configuration.",
    project_pack_empty: "No input was provided. Choose a file or paste pack text first.",
    project_pack_read_failed: "The input is not valid JSON.",
    project_pack_unknown_field: "The pack contains an unknown field. Remove fields outside the project pack schema.",
  };
  if (known[reason] !== undefined) return known[reason];
  const invalidField = /^project_pack_field_invalid:(title|summary|optionalModules|setupGuidance|attribution|license)$/.exec(reason);
  if (invalidField) return `The ${invalidField[1]} field has the wrong shape. Check the pack schema.`;
  const fieldIssue = /^project_pack_field_invalid:(title|summary|optionalModules|setupGuidance|attribution|license):(too_small|too_big|invalid_type|invalid_format|invalid_value)$/.exec(reason);
  if (fieldIssue) {
    const [,field,code] = fieldIssue;
    const lengths:Record<string,number>={title:120,summary:2000,attribution:120,license:40,setupGuidance:1000};
    if(code==="too_small")return `The ${field} field contains an empty value. Provide text for this field.`;
    if(code==="too_big")return field==="optionalModules"||field==="setupGuidance"
      ? `The ${field} field exceeds its allowed item or text length ceiling.`
      : `The ${field} field exceeds its ${lengths[field!]}-character ceiling.`;
    return `The ${field} field has the wrong shape or format. Check its type in the pack schema.`;
  }
  const unknownField = /^project_pack_unknown_field:([A-Za-z0-9_]{1,64})$/.exec(reason);
  if(unknownField)return `The pack contains an unknown field: ${unknownField[1]}. Remove this field.`;
  const fieldMatch = /^project_pack_([a-z0-9]+)_(not_printable|credential_shaped|authority_shaped|executable_content)$/.exec(reason);
  if (fieldMatch) {
    const [, field, kind] = fieldMatch;
    const fieldLabel = field === "guidance" ? "setup guidance" : field;
    const kindText = kind === "not_printable" ? "contains non-printable control characters"
      : kind === "credential_shaped" ? "looks like a credential, API key, or private key"
      : kind === "authority_shaped" ? "contains authority-shaped text (permission/role directives)"
      : "contains executable-content markers (script tags, javascript:, event handlers)";
    return `The ${fieldLabel} ${kindText}.`;
  }
  return `The pack was refused: ${reason}`;
}

/**
 * Parse and preview a raw local pack entirely client-side.
 *
 * Pure and synchronous: no network, no catalog, no upload, no project
 * creation, no credential, no executable-content evaluation beyond the
 * canonical parser's existing refusal check. `localConfiguration` describes
 * the trusted local product configuration (which optional modules are
 * available locally) and is validated by the canonical preview.
 */
export function browseProjectPackV1(
  raw: RawPackInputV1 | null,
  localConfiguration: ProjectPackLocalConfigurationV1,
): ProjectPackBrowseOutcomeV1 {
  if (raw === null) {
    return { status: "refused", reason: "project_pack_empty" };
  }
  if (portableUtf8ByteLengthV1(raw.rawText) > PROJECT_PACK_MAX_BYTES_V1) {
    return { status: "refused", reason: "project_pack_input_oversized" };
  }
  if (raw.rawText.replace(/\0/gu, "").trim().length === 0) {
    return { status: "refused", reason: "project_pack_empty" };
  }
  let pack: Readonly<ProjectPackV1>;
  try {
    pack = withParserByteLengthV1(() => parseProjectPackV1(JSON.parse(raw.rawText)));
  } catch (error) {
    return { status: "refused", reason: projectPackRefusalReasonV1(error) };
  }
  const preview = withParserByteLengthV1(() => previewProjectPackV1(pack, localConfiguration));
  return { status: "ready", pack, preview };
}

function projectPackRefusalReasonV1(error: unknown): string {
  if (error instanceof SyntaxError) return "project_pack_read_failed";
  if (error instanceof z.ZodError) {
    const canonical = error.issues.find(issue => /^project_pack_[a-z_]+$/.test(issue.message));
    if (canonical) return canonical.message;
    const issue = error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      const key=issue.keys[0];
      return key&&/^[A-Za-z0-9_]{1,64}$/.test(key)?`project_pack_unknown_field:${key}`:"project_pack_unknown_field";
    }
    if (issue?.path[0] === "optionalModules" && issue.code === "invalid_value") return "project_pack_unknown_module";
    const field = issue?.path[0];
    if (typeof field === "string" && ["title", "summary", "optionalModules", "setupGuidance", "attribution", "license"].includes(field)) {
      return `project_pack_field_invalid:${field}:${issue!.code}`;
    }
    return "project_pack_malformed";
  }
  if (error instanceof Error && /^project_pack_[a-z_]+$/.test(error.message)) return error.message;
  return "project_pack_malformed";
}

/** The schema literal, re-exported for the presentation component's helper text. */
export { PROJECT_PACK_SCHEMA_V1, PROJECT_PACK_MAX_BYTES_V1 };
