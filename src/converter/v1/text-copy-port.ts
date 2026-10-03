export const TEXT_COPY_DERIVATION_SCHEMA = "control-room.text-copy-derivation/v1" as const;

export type TextCopySourceFormat = "html" | "pdf" | "docx" | "pptx" | "audio";

export type TextCopyDiagnosticCategory =
  | "none"
  | "invalid_input"
  | "input_too_large"
  | "not_supported_yet"
  | "converter_unavailable"
  | "sandbox_unavailable"
  | "timeout"
  | "cancelled"
  | "memory_limit"
  | "resource_monitor_unavailable"
  | "output_too_large"
  | "conversion_failed";

export interface TextCopyConversionRequest {
  readonly format: TextCopySourceFormat;
  readonly sourceBytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface TextCopyConverterIdentity {
  readonly id: string;
  readonly version: string;
}

/**
 * Storage-neutral output. A persistence adapter may store this record and the
 * markdown bytes, but the converter owns no database or blob-store authority.
 */
export interface TextCopyDerivationResult {
  readonly schema: typeof TEXT_COPY_DERIVATION_SCHEMA;
  readonly sourceDigest: `sha256:${string}`;
  readonly converter: TextCopyConverterIdentity;
  readonly status: "succeeded" | "no_text_copy";
  readonly diagnosticCategory: TextCopyDiagnosticCategory;
  readonly markdownBytes: Uint8Array;
}

export interface TextCopyConverterPort {
  convert(request: TextCopyConversionRequest): Promise<TextCopyDerivationResult>;
}
