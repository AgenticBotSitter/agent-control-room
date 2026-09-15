// Bounded selected-file reads for the offline preparation explainer.
//
// Reads at most MAX_PREPARATION_INPUT_BYTES + 1 bytes through an open handle
// and closes the handle on every exit, so an oversized file can never consume
// unbounded memory before refusal. Non-regular inputs (directories, devices,
// fifos) and unreadable paths refuse as null; callers render the generic
// refusal without echoing paths or data. The opener is injectable so tests
// can prove the reader stops at the limit with a fake handle.

export const MAX_PREPARATION_INPUT_BYTES = 1024 * 1024;

export async function readBoundedText(path, deps = {}) {
  const opener = deps.open ?? (await import('node:fs/promises')).open;
  let handle;
  try {
    handle = await opener(path, 'r');
  } catch {
    return null;
  }
  const close = async () => {
    try {
      await handle.close();
    } catch {
      // Close must never mask the refusal or throw a new error.
    }
  };
  try {
    const stat = await handle.stat();
    if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
      await close();
      return null;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const read = await handle.read();
      if (!read || read.bytesRead === 0) break;
      chunks.push(read.buffer.subarray(0, read.bytesRead));
      total += read.bytesRead;
      if (total > MAX_PREPARATION_INPUT_BYTES) {
        await close();
        return null;
      }
    }
    await close();
    return Buffer.concat(chunks, total).toString('utf8');
  } catch {
    await close();
    return null;
  }
}
