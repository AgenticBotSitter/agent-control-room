// Bounded selected-file reads for the offline preparation explainer.
//
// Reads at most MAX_PREPARATION_INPUT_BYTES + 1 bytes through an open handle
// and closes the handle on every exit, so an oversized file can never consume
// unbounded memory before refusal. Non-regular inputs (directories, devices,
// fifos) and unreadable paths refuse as null; callers render the generic
// refusal without echoing paths or data. The opener is injectable so tests
// can prove the reader stops at the limit with a fake handle.
//
// Each handle.read() is bounded by the remaining budget so a single read can
// never overshoot the strict limit-plus-one ceiling. The handle is opened
// with O_NONBLOCK | O_RDONLY so a FIFO never blocks the opener before stat
// can identify it as non-regular.

import { constants as fsConstants } from 'node:fs';

export const MAX_PREPARATION_INPUT_BYTES = 1024 * 1024;

const OPEN_FLAGS = fsConstants.O_NONBLOCK | fsConstants.O_RDONLY;

export async function readBoundedText(path, deps = {}) {
  const opener = deps.open ?? (await import('node:fs/promises')).open;
  let handle;
  try {
    handle = await opener(path, OPEN_FLAGS);
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
      // Strict limit-plus-one ceiling: each read may consume at most the
      // remaining budget, so total can never exceed MAX + 1 after a read.
      const remaining = MAX_PREPARATION_INPUT_BYTES - total + 1;
      const read = await handle.read(null, remaining);
      if (!read || read.bytesRead === 0) break;
      if (read.bytesRead > remaining) {
        await close();
        return null;
      }
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
