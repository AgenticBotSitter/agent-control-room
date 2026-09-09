import { z } from "zod";

// Shared pure representation check. DNS/address/TLS enforcement remains in the target guard.
const destinationPattern = /^https:\/\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):([1-9][0-9]{0,4})$/;
function isCanonicalNetworkDestination(value: string): boolean {
  const match = destinationPattern.exec(value);
  if (!match || match[1].includes("..")) return false;
  const labels = match[1].split(".");
  if (labels.some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/.test(label))) return false;
  if (Number(match[2]) > 65_535) return false;
  try { if (new URL(`https://${match[1]}`).hostname !== match[1]) return false; }
  catch { return false; }
  return true;
}
// Expose the already-enforced basic syntax in generated JSON Schema too. Full canonical
// label/port/URL checks remain the runtime refinement, not a JSON-Schema-only authority check.
export const canonicalNetworkDestinationSchema = z.string().min(12).max(300).regex(destinationPattern).refine(isCanonicalNetworkDestination,
  "network destination must be canonical https host and explicit port");
