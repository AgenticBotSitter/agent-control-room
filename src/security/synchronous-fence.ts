/** A returned promise is not a completed synchronous fence. Observe rejection
 * without awaiting or treating it as permission for a following effect. */
export function assertSynchronousFence(check: () => unknown, fail: () => never): void {
  const result = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    fail();
  }
}
