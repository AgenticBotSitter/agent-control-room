import { z } from "zod";
import { isPostgresTextV1 } from "../../persistence/postgres-text";
import { catalogProjectIdSchema as id } from "./project-wire";

/**
 * The wire contract for the result-file catalog: what a set produced, and what
 * the owner may download from it.
 *
 * Two rules shape every field here.
 *
 * First, a download link is a capability, not a location. `downloadHref` names
 * a protected route and a short-lived token; the storage key, the byte path and
 * any object-store URL never appear. There is deliberately no field for them.
 *
 * Second, "what this file is" is reported honestly rather than resolved. A
 * `declared` type and a `detected` type are both present, and when they differ
 * the UI says so instead of quietly trusting the declared one. An owner who
 * received a `.png` that is actually HTML deserves to see that written down.
 */
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const setId = z.string().regex(/^result-set:[a-f0-9]{32}$/u);
const fileId = z.string().regex(/^result-file:[a-f0-9]{32}$/u);
// `text/html` is here for one reason: it is the type a hostile file most wants
// to be, and it is exactly the case the declared/detected split exists to make
// visible. A worker that uploads a `.png` that is really HTML is a fact the
// owner must be able to see, so the value is in the vocabulary rather than
// refused. It is never rendered inline: the download is an attachment with
// nosniff and a sandbox CSP, and the browser is told `application/octet-stream`.
const mediaType = z.enum(["text/plain", "text/markdown", "text/csv", "text/html", "application/json",
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip",
  "application/octet-stream"]);
export const resultFileDisplayNameSchema = z.string().min(1).max(120).refine(isPostgresTextV1)
  // The same shape the schema enforces. Repeated here because this value is
  // echoed into a Content-Disposition header, and a browser is the last place a
  // header injection would be caught.
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !/["\\/]/.test(value)
    && !value.includes("..") && !value.startsWith(".") && /^[A-Za-z0-9]/.test(value));

export const resultFileItemSchema = z.object({
  fileId,
  ordinal: z.number().int().min(1).max(32),
  displayName: resultFileDisplayNameSchema,
  declaredMediaType: mediaType,
  detectedMediaType: mediaType,
  sizeBytes: z.number().int().min(0).max(268_435_456),
  contentDigest: digest,
  state: z.enum(["declared", "stored", "quarantined", "missing"]),
  receivedAt: z.string().datetime(),
  /** Present only for a stored file the owner may fetch right now. */
  downloadHref: z.string().startsWith("/api/v1/").max(4096).optional(),
}).strict();
export type ResultFileItem = z.infer<typeof resultFileItemSchema>;

export const resultFileSetSchema = z.object({
  setId,
  projectId: id,
  jobId: id,
  state: z.enum(["declared", "stored", "incomplete", "quarantined"]),
  sourceKind: z.enum(["native-text", "file-store"]),
  producerKind: z.enum(["native", "fleet"]),
  /** A worker id or the fixed local marker. Never a hostname. */
  producerId: z.string().min(1).max(180),
  manifestDigest: digest,
  retentionState: z.enum(["provisional", "retained", "trash", "purged"]),
  files: z.array(resultFileItemSchema).max(32),
  additionalFilesOmitted: z.boolean(),
}).strict();
export type ResultFileSet = z.infer<typeof resultFileSetSchema>;

/** The "Delivered files" list on a task page, or on Project Files. */
export const resultFileCatalogSchema = z.object({
  projectId: id,
  jobId: id.optional(),
  sets: z.array(resultFileSetSchema).max(20),
  additionalSetsOmitted: z.boolean(),
  /** `not_configured` when no byte store is wired; never an empty list in its place. */
  catalogSource: z.enum(["configured", "not_configured"]),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.sets.some(set => set.projectId !== value.projectId))
    context.addIssue({ code: "custom", message: "a result set must belong to the project it is listed under" });
  if (value.jobId !== undefined && value.sets.some(set => set.jobId !== value.jobId))
    context.addIssue({ code: "custom", message: "a result set must belong to the job it is listed under" });
  // A download link on a file that is not stored would hand the owner a route
  // that can only fail; a file with no link is honest, and this makes the
  // difference impossible to express wrongly.
  for (const set of value.sets) for (const file of set.files)
    if (file.downloadHref !== undefined && file.state !== "stored")
      context.addIssue({ code: "custom", message: "only a stored file carries a download link" });
  if (value.catalogSource !== "configured" && value.sets.length)
    context.addIssue({ code: "custom", message: "an unconfigured catalog cannot report sets" });
});
export type ResultFileCatalog = z.infer<typeof resultFileCatalogSchema>;

/** One downloadable file, resolved at request time. Never cached by a browser. */
export const resultFileDownloadSchema = z.object({
  displayName: resultFileDisplayNameSchema,
  mediaType,
  sizeBytes: z.number().int().min(0).max(268_435_456),
  contentDigest: digest,
  /** The exact bytes, read once and proven against `contentDigest`. */
  bytes: z.instanceof(Uint8Array),
  grantId: z.string().regex(/^result-grant:[a-f0-9]{32}$/u),
}).strict();
export type ResultFileDownload = z.infer<typeof resultFileDownloadSchema>;
