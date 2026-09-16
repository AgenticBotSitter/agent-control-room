/**
 * Reusable cross-harness connector conformance runner (testing API).
 *
 * A new harness contributor imports this module to exercise the existing connector-profile
 * and canonical-text-result rules instead of copying separate tests. It is not a harness
 * contract, publisher, scheduler, registry or permission model, and it enables nothing.
 */
export * from "./contract";
export * from "./runner";