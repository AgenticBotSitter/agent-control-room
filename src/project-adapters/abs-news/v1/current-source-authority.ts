/** Trusted, synchronous snapshot assertion. Async permission lookups must complete before
 * constructing this guard; returning a Promise is never permission to begin an effect. */
export interface AbsCurrentSourceAuthority {
  assertCurrent(url: string): undefined;
}

export function captureAbsCurrentSourceAuthority(source: AbsCurrentSourceAuthority): (url: string) => void {
  const check = source.assertCurrent.bind(source);
  return url => {
    const result: unknown = check(url);
    if (result !== undefined) {
      // Observe a miswired native Promise's rejection without awaiting it or allowing work.
      if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => undefined);
      throw new Error("abs_source_authority_unavailable");
    }
  };
}
