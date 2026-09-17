/** Read-only pre-assignment recommendation surface (WORK-014).
 *
 *  This module explains why a machine is a reasonable choice before an assignment is made.
 *  It exports no command, contacts no provider, reads no store and reserves no capacity:
 *  every projection it returns declares `authority` false and binding the projection to a
 *  project, task and input digest is the caller's completeness check.
 */
export * from "./types";
export * from "./evidence";
export * from "./recommendation";
export { assignmentRecommendationAlternativeSchemaV1, assignmentRecommendationProjectionSchemaV1 } from "./schema";