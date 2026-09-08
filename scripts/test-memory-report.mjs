// Optional measurement preload. Does not change tests, GC, or exit status.
// Node reports maxRSS in KiB on both Linux and macOS.
import { basename } from "node:path";

process.once("exit", code => {
  process.stderr.write(`${JSON.stringify({
    measurement: "test-process-memory/v1",
    entry: basename(process.argv[1] ?? "node"),
    platform: process.platform,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10,
    exitCode: code,
  })}\n`);
});
