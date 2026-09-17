import {
  parseProjectPackV1,
  previewProjectPackV1,
  PROJECT_PACK_SCHEMA_V1,
  type ProjectPackPreviewV1,
  type ProjectPackV1,
} from "./project-pack";

/**
 * Browser-safe entry point over the canonical project-pack parser.
 *
 * The canonical parser is shared, reviewed code that measures raw-input size
 * with Node's `Buffer.byteLength`. In a browser there is no `Buffer` global,
 * so a direct call would throw before any pack is previewed. This module
 * provides the missing UTF-8 byte measurement *for the duration of one call*,
 * then restores the previous global state — the parser itself is imported
 * unmodified and its byte ceiling (`project_pack_input_oversized` at 65536
 * bytes) and all guard semantics are preserved exactly.
 *
 * The same requirement holds for the schema/roundtrip tests, which always run
 * under Node. In a real browser without Node globals this fallback uses the
 * Web-standard `TextEncoder` to compute identical UTF-8 byte counts
 * (`TextEncoder().encode(s).length === Buffer.byteLength(s, "utf8")` for all
 * valid strings).
 */

/** The exact runtime `Buffer` shape the parser needs. */
type NodeBufferLike = { byteLength: (input: string, encoding?: string) => number };

function utf8ByteLengthV1(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Parse-time fallback for pre-TextEncoder engines: UTF-16 code units ≥ UTF-8
  // bytes, so this never accepts an input the canonical guard would refuse.
  return text.length;
}

/**
 * Run `body` with a `Buffer`-shaped byteLength available, then restore the
 * prior global value (whether absent, undefined, a data property, or the
 * Node lazy accessor) in a `finally` block. Call-scoped and synchronous:
 * nothing is installed for the lifetime of the page and nothing is left
 * modified on any exit path. Exported so tests can prove the canonical
 * parser runs unmodified through the same bridge the panel uses.
 */
export function withParserByteLengthV1<T>(body: () => T): T {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  const needsBridge = typeof globalThis.Buffer !== "function";
  if (!needsBridge) return body();
  try {
    const bridge: NodeBufferLike = {
      byteLength: (input: string, encoding?: string): number => {
        if (encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8") {
          throw new Error("project_pack_unsupported_encoding");
        }
        return utf8ByteLengthV1(input);
      },
    };
    Object.defineProperty(globalThis, "Buffer", { configurable: true, value: bridge });
    return body();
  } finally {
    if (prior === undefined) {
      delete (globalThis as Record<string, unknown>).Buffer;
    } else {
      Object.defineProperty(globalThis, "Buffer", prior);
    }
  }
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
  };
  if (known[reason] !== undefined) return known[reason];
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
  if (raw === null || raw.rawText.length === 0) {
    return { status: "refused", reason: "project_pack_empty" };
  }
  let pack: Readonly<ProjectPackV1>;
  try {
    pack = withParserByteLengthV1(() => parseProjectPackV1(JSON.parse(raw.rawText)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "refused", reason: reason.startsWith("project_pack_") ? reason : "project_pack_read_failed" };
  }
  const preview = withParserByteLengthV1(() => previewProjectPackV1(pack, localConfiguration));
  return { status: "ready", pack, preview };
}

/** The schema literal, re-exported for the presentation component's helper text. */
export { PROJECT_PACK_SCHEMA_V1 };
