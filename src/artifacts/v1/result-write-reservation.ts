import { z } from "zod";
import { sha256Digest } from "../../security";

/**
 * Shared pre-write reservation state machine for durable text-result
 * publication. Native and Codex reservations run the identical lifecycle
 * (reserved -> bytes_verified -> metadata_committed, with a terminal
 * storage_uncertain branch); only the identity evidence, identifier
 * prefixes and error labels differ per harness. Those differences are
 * parameters, so neither harness receipt is ever relabelled for the other.
 */

export const resultWriteReservationStates = ["reserved", "bytes_verified", "metadata_committed", "storage_uncertain"] as const;
export type ResultWriteReservationState = (typeof resultWriteReservationStates)[number];
export type ResultWriteLastCertainState = "reserved" | "bytes_verified";

export interface ResultWriteReservationIdentityShape {
  artifactId: string;
  contentHash: string;
  sizeBytes: number;
}

export interface ResultWriteReservationShape<Identity extends ResultWriteReservationIdentityShape> {
  reservationId: string;
  identity: Identity;
  identityDigest: string;
  state: ResultWriteReservationState;
  bytesVerificationDigest: string | null;
  manifestDigest: string | null;
  receiptDigest: string | null;
  uncertaintyDigest: string | null;
  lastCertainState: ResultWriteLastCertainState | null;
  contractDigest: string;
}

export interface ReservationTransitionFields {
  bytesVerificationDigest: string | null;
  manifestDigest: string | null;
  receiptDigest: string | null;
  uncertaintyDigest: string | null;
  lastCertainState: ResultWriteLastCertainState | null;
}

export interface ReservationMachineOptions<Identity extends ResultWriteReservationIdentityShape> {
  reservationSchema: z.ZodTypeAny;
  /** Builds the harness material record (literals, flags, identifiers); the machine adds the contract digest. */
  materialize: (input: { reservationId: string; identity: Identity; identityDigest: string;
    state: ResultWriteReservationState } & ReservationTransitionFields) => Record<string, unknown>;
  /** Derives the expected bytes-verification digest for an identity. */
  bytesVerificationDigest: (identity: Identity) => string;
  /** Derives the canonical reservation id for an identity digest. */
  reservationId: (identityDigest: string) => string;
  unavailable: () => never;
  conflict: () => never;
  /**
   * Native compares digests on uncertain/bytes replay; Codex relies on schema
   * self-consistency. Preserved exactly per harness so delegation never
   * weakens either side.
   */
  compareReplayDigests: boolean;
}

function deepFreezeMachine<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreezeMachine((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /_conflict$/.test(error.message);
}

export interface ResultWriteReservationMachine<Identity extends ResultWriteReservationIdentityShape> {
  buildReserved: (identity: Identity) => unknown;
  verifyBytes: (reservationValue: unknown, bytesValue: Uint8Array,
    checkBytes: (bytes: Uint8Array, claim: { contentHash: string; sizeBytes: number }) => unknown) => unknown;
  commitMetadata: (reservationValue: unknown, manifestDigestValue: unknown, receiptDigestValue: unknown) => unknown;
  markStorageUncertain: (reservationValue: unknown, uncertaintyDigestValue: unknown) => unknown;
}

/**
 * Binds the shared lifecycle to one harness identity shape. The returned
 * transitions throw the harness's own errors and preserve its replay
 * strictness; schemas, literals and digests stay in the harness module.
 */
export function createResultWriteReservationMachine<Identity extends ResultWriteReservationIdentityShape>(
  options: ReservationMachineOptions<Identity>,
): ResultWriteReservationMachine<Identity> {
  const { reservationSchema, materialize, bytesVerificationDigest, reservationId, unavailable, conflict } = options;
  const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

  const build = (identity: Identity, state: ResultWriteReservationState,
    fields: ReservationTransitionFields): unknown => {
    const identityDigest = sha256Digest(identity);
    const material = materialize({ reservationId: reservationId(identityDigest), identity, identityDigest, state, ...fields });
    return deepFreezeMachine(reservationSchema.parse({ ...material, contractDigest: sha256Digest(material) }));
  };

  return {
    buildReserved: identity => build(identity, "reserved", { bytesVerificationDigest: null,
      manifestDigest: null, receiptDigest: null, uncertaintyDigest: null, lastCertainState: null }),

    verifyBytes: (reservationValue, bytesValue, checkBytes) => {
      try {
        const reservation = reservationSchema.parse(reservationValue) as ResultWriteReservationShape<Identity>;
        checkBytes(bytesValue, reservation.identity);
        const expected = bytesVerificationDigest(reservation.identity);
        if (reservation.state === "storage_uncertain") return unavailable();
        if (reservation.bytesVerificationDigest !== null) {
          if (options.compareReplayDigests && reservation.bytesVerificationDigest !== expected) conflict();
          return deepFreezeMachine(reservation);
        }
        if (reservation.state !== "reserved") return unavailable();
        return build(reservation.identity, "bytes_verified", { bytesVerificationDigest: expected,
          manifestDigest: null, receiptDigest: null, uncertaintyDigest: null, lastCertainState: null });
      } catch (error) {
        if (isConflict(error)) throw error;
        return unavailable();
      }
    },

    commitMetadata: (reservationValue, manifestDigestValue, receiptDigestValue) => {
      try {
        const reservation = reservationSchema.parse(reservationValue) as ResultWriteReservationShape<Identity>;
        const manifestDigest = digestSchema.parse(manifestDigestValue);
        const receiptDigest = digestSchema.parse(receiptDigestValue);
        if (reservation.state === "metadata_committed") {
          if (reservation.manifestDigest !== manifestDigest || reservation.receiptDigest !== receiptDigest) conflict();
          return deepFreezeMachine(reservation);
        }
        if (reservation.state !== "bytes_verified" || reservation.bytesVerificationDigest === null) return unavailable();
        return build(reservation.identity, "metadata_committed", {
          bytesVerificationDigest: reservation.bytesVerificationDigest, manifestDigest, receiptDigest,
          uncertaintyDigest: null, lastCertainState: null });
      } catch (error) {
        if (isConflict(error)) throw error;
        return unavailable();
      }
    },

    markStorageUncertain: (reservationValue, uncertaintyDigestValue) => {
      try {
        const reservation = reservationSchema.parse(reservationValue) as ResultWriteReservationShape<Identity>;
        const uncertaintyDigest = digestSchema.parse(uncertaintyDigestValue);
        if (reservation.state === "storage_uncertain") {
          if (options.compareReplayDigests && reservation.uncertaintyDigest !== uncertaintyDigest) conflict();
          return deepFreezeMachine(reservation);
        }
        if (reservation.state !== "reserved" && reservation.state !== "bytes_verified") return unavailable();
        return build(reservation.identity, "storage_uncertain", {
          bytesVerificationDigest: reservation.bytesVerificationDigest, manifestDigest: null, receiptDigest: null,
          uncertaintyDigest, lastCertainState: reservation.state });
      } catch (error) {
        if (isConflict(error)) throw error;
        return unavailable();
      }
    },
  };
}

/** Canonical bytes-verification digest shared by every reservation flavor. */
export function resultBytesVerificationDigestV1(identity: ResultWriteReservationIdentityShape): string {
  return sha256Digest({ artifactId: identity.artifactId, contentHash: identity.contentHash,
    sizeBytes: identity.sizeBytes, verifiedBytesHash: identity.contentHash, verifiedSizeBytes: identity.sizeBytes });
}
