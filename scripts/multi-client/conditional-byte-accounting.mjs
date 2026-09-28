const representationKey = (resource, etag) => `${resource}\0${etag}`;

/**
 * Counts the exact response-body bytes omitted by conditional reads.
 *
 * A 304 has no response body, so its saving is the byte length of the known
 * 200 representation named by that request's If-None-Match value. The resource
 * is part of the key so equally named validators on different routes cannot be
 * mixed together.
 */
export function createConditionalByteAccounting() {
  const representationBytes = new Map();
  let avoidedBytes = 0;

  return Object.freeze({
    record({ resource, status, bytes, etag, conditional }) {
      if (status === 200 && etag) {
        representationBytes.set(representationKey(resource, etag), bytes);
        return;
      }
      if (status !== 304) return;
      if (!conditional) throw new Error(`multi_client_304_without_conditional resource=${resource}`);
      const knownBytes = representationBytes.get(representationKey(resource, conditional));
      if (knownBytes === undefined) {
        throw new Error(`multi_client_304_without_known_representation resource=${resource}`);
      }
      avoidedBytes += knownBytes;
    },
    avoidedBytes: () => avoidedBytes,
  });
}
