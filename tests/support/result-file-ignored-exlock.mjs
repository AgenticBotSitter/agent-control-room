// Reproduce a filesystem that ignores only the BSD O_EXLOCK bit. Imported in
// an isolated child so the native Mac control and its live writer stay real.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
export const ignoredExlockHandles = new Set();
for (const [object, method] of [[fs, "openSync"], [fsp, "open"]]) {
  const original = object[method];
  object[method] = function(path, flags, ...rest) {
    const result = original.call(this, path, typeof flags === "number" ? flags & ~0x20 : flags, ...rest);
    if (object !== fsp || typeof flags !== "number" || !(flags & 0x20)) return result;
    return result.then(handle => {
      ignoredExlockHandles.add(handle);
      const close = handle.close.bind(handle);
      handle.close = async () => { try { await close(); } finally { ignoredExlockHandles.delete(handle); } };
      return handle;
    });
  };
}
syncBuiltinESMExports();
