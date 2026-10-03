// Expose the existing injected-clock primitive only in this test import. The
// fault is at the real atomic write, so locking and merge still execute normally.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/scripts/fleet/connector.mjs?held-recovery-test")) {
    const loaded = await nextLoad(url, context);
    let source = loaded.source.toString();
    const anchor = '      const handle = await open(temporary, "wx", 0o600);';
    if (source.split(anchor).length !== 2) throw new Error("held recovery fault anchor drift");
    source = source.replace(anchor, `      if (globalThis.heldRecoveryWriteFailures > 0) {
        globalThis.heldRecoveryWriteFailures -= 1;
        throw Object.assign(new Error("controlled temporary disk refusal"), { code: "ENOSPC" });
      }
` + anchor);
    const syncAnchor = '  const parent = await open(directory, "r");';
    if (source.split(syncAnchor).length !== 2) throw new Error("held recovery sync anchor drift");
    source = source.replace(syncAnchor, syncAnchor + `
  const realSync = parent.sync.bind(parent);
  parent.sync = async () => {
    if (globalThis.heldRecoverySyncFailures > 0) {
      globalThis.heldRecoverySyncFailures -= 1;
      throw Object.assign(new Error("controlled directory sync refusal"), { code: "ENOSPC" });
    }
    return realSync();
  };
`);
    return { format: "module", shortCircuit: true, source: source +
      "\nexport { deliverHeldResult as testDeliver, readHeldResult as testRead, writeHeldResult as testWrite, withHeldResultLock as testLock };\n" };
  }
  return nextLoad(url, context);
}
