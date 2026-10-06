/** A newline commits a journal record. Only the last record may be torn.
 * Callers must validate every returned value before truncating under their lock.
 * Security/authority ledgers and atomic replacement files must pass
 * recoverTail: false: a torn record may already have authorized an effect.
 */
export function readJsonlPrefixV1(text, { recoverTail = true, maxLineBytes = Infinity, refuse } = {}) {
  const values = []; let bytes = 0;
  const lines = text.split("\n");
  const completeCount = lines.length - 1;
  for (let index = 0; index < completeCount; index += 1) {
    const line = lines[index]; let value;
    try { value = JSON.parse(line); }
    catch {
      if (recoverTail && index === completeCount - 1 && lines.at(-1) === "") break;
      refuse(`invalid JSON on journal line ${index + 1}`);
    }
    if (Buffer.byteLength(line) > maxLineBytes) refuse(`journal line ${index + 1} is too large`);
    values.push(value); bytes += Buffer.byteLength(line) + 1;
  }
  if (!recoverTail && lines.at(-1) !== "") refuse("journal final line has no newline");
  return { values, bytes, repaired: bytes !== Buffer.byteLength(text) };
}
