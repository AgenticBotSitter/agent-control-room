import type { ProtocolRateLimitGuard } from "./types";

interface Bucket {
  windowStartMs: number;
  count: number;
}

export class FixedWindowProtocolRateLimiter implements ProtocolRateLimitGuard {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maximum: number,
    private readonly windowSeconds: number,
    private readonly maximumBuckets = 10_000,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Rate limit maximum must be a positive integer");
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error("Rate limit window must be a positive integer");
    if (!Number.isInteger(maximumBuckets) || maximumBuckets < 1) throw new Error("Rate limit bucket ceiling must be a positive integer");
  }

  async consume(input: Parameters<ProtocolRateLimitGuard["consume"]>[0]): Promise<void> {
    if (!input.transportIdentity || input.transportIdentity.length > 256) throw new Error("Invalid transport identity");
    const now = Date.parse(input.receivedAt);
    if (!Number.isFinite(now)) throw new Error("Invalid rate-limit timestamp");
    // This check runs before signature verification, so claimed tenant/actor
    // fields are attacker-controlled and must not partition the transport bucket.
    const bucketKey = `${input.transportIdentity}\u0000${input.direction}`;
    const windowMs = this.windowSeconds * 1_000;
    const existing = this.buckets.get(bucketKey);
    if (!existing || now - existing.windowStartMs >= windowMs) {
      if (!existing && this.buckets.size >= this.maximumBuckets) this.prune(now, windowMs);
      if (!existing && this.buckets.size >= this.maximumBuckets) throw new Error("Rate-limit capacity reached");
      this.buckets.set(bucketKey, { windowStartMs: now, count: 1 });
      return;
    }
    if (existing.count >= this.maximum) throw new Error("Rate limit exceeded");
    existing.count += 1;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartMs >= windowMs) this.buckets.delete(key);
    }
  }
}
