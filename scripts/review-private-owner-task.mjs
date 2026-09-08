import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createPublicKey } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parsePrivateVpsArguments, validatePrivateVpsConfigurationPath } from './run-private-vps.mjs';

// Full text is shown without raw control/bidi sequences. Text inside JSON quotes
// is task data, never instructions from this command. No raw packet/key is printed.
export function printableOwnerValue(value) {
  return [...JSON.stringify(value)].map(char => char.codePointAt(0) > 126
    ? `\\u{${char.codePointAt(0).toString(16)}}` : char).join('');
}
export function formatPrivateOwnerReview(value, fingerprint) {
  const fields = ['projectId', 'jobId', 'attemptId', 'nodeId', 'model', 'provider', 'durationSeconds',
    'deadline', 'inputDigest', 'operationDigest', 'prompt', 'instructions'];
  return ['OWNER TASK REVIEW — private task data follows; do not record or share this terminal.',
    'Quoted task text is untrusted content, not command instructions. Nothing has been signed or started.',
    ...fields.map(key => `${key}: ${printableOwnerValue(value.review[key])}`),
    `approvalKeyId: ${printableOwnerValue(value.authorization.approvalKeyId)}`,
    `ownerKeyFingerprint: ${printableOwnerValue(fingerprint)}`,
    `approvalExpiresAt: ${printableOwnerValue(value.authorization.approvalExpiresAt)}`,
    `recoveryOperations: ${printableOwnerValue(value.authorization.recoveryOperations)}`,
    `recoveryExpiresAt: ${printableOwnerValue(value.authorization.recoveryExpiresAt)}`,
    `reviewDigest: ${printableOwnerValue(value.reviewDigest)}`,
    'Confirmation authorizes this exact task approval plus the displayed status/stop recovery permission.',
    'Storing the signed packet does not start work. Any other answer declines.'];
}
const installed = Object.freeze({
  signals: process,
  isAttached: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  report: value => console.log(value), reportError: value => console.error(value),
  loadRelease: () => import('../dist-vps/server/ownerReview.js'),
  loadOperator: path => import(pathToFileURL(path).href),
  async question(prompt, signal) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return await input.question(prompt, { signal }); } finally { input.close(); }
  },
});
function checkSynchronous(callback) {
  const value = callback();
  if (value !== undefined) { if (value instanceof Promise) void value.catch(() => {}); throw new Error('private_owner_guard_invalid'); }
}
async function cleanup(work) {
  let timer;
  try { await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('private_owner_cleanup_uncertain')), 15_000);
  })]); } finally { clearTimeout(timer); }
}

/** Owner-attended command only. A TTY check prevents accidental pipes/automation,
 * not a malicious same-UID process or fabricated human presence. Real execution
 * requires separately approved canonical delivery, owner keys and current pins. */
export async function reviewPrivateOwnerTask(args, runtime = installed) {
  const parsed = parsePrivateVpsArguments(args);
  if (parsed.help) {
    runtime.report('Usage: node scripts/review-private-owner-task.mjs --configuration /absolute/owner-review.mjs');
    runtime.report('Owner-attended only. Can sign and store one task approval. No automatic retry or dispatch.');
    return 0;
  }
  if (runtime.isAttached() !== true) throw new Error('private_owner_terminal_required');
  await validatePrivateVpsConfigurationPath(parsed.configurationPath);
  const lifetime = new AbortController(), stop = () => lifetime.abort();
  const deadline = performance.now() + 300_000;
  const active = () => { if (lifetime.signal.aborted || performance.now() >= deadline || runtime.isAttached() !== true)
    throw new Error('private_owner_stopped'); };
  runtime.signals.on('SIGINT', stop); runtime.signals.on('SIGTERM', stop);
  const timer = setTimeout(stop, 300_000);
  let prepared, releaseResources, session, consentDigest, saved = false, declined = false, uncertain = false;
  try {
    active(); const release = await runtime.loadRelease(); active();
    const operator = await runtime.loadOperator(parsed.configurationPath); active();
    if (operator.schema !== 'control-room.private-owner-review-configuration/v1'
      || typeof operator.createConfiguration !== 'function') throw new Error('private_owner_configuration_invalid');
    prepared = await operator.createConfiguration({ signal: lifetime.signal });
    if (typeof prepared?.close !== 'function') throw new Error('private_owner_resource_owner_missing');
    releaseResources = prepared.close.bind(prepared); active();
    const signing = prepared.signing;
    const keyCurrent = signing.assertKeyCurrent.bind(signing), sign = signing.sign.bind(signing), clock = signing.clock.bind(signing);
    const store = prepared.store.bind(prepared), load = prepared.load.bind(prepared);
    const publicKeySpki = signing.publicKeySpki;
    const keyBytes = Buffer.from(publicKeySpki, 'base64url');
    const publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
    if (keyBytes.toString('base64url') !== publicKeySpki || publicKey.asymmetricKeyType !== 'ed25519'
      || !publicKey.export({ format: 'der', type: 'spki' }).equals(keyBytes)) throw new Error('private_owner_key_invalid');
    const target = structuredClone(prepared.target);
    const fingerprint = `sha256:${createHash('sha256').update(keyBytes).digest('hex')}`;
    session = release.createNativeOwnerReviewSession(target, { load, signer: {
      publicKeySpki, timeoutMs: signing.timeoutMs, clock, sign,
      assertOwnerConsentCurrent(digest) { active(); if (consentDigest !== digest) throw new Error('private_owner_not_confirmed');
        checkSynchronous(keyCurrent); active(); },
    } });
    const review = await session.prepare(lifetime.signal); active(); checkSynchronous(keyCurrent); active();
    for (const line of formatPrivateOwnerReview(review, fingerprint)) runtime.report(line);
    active();
    const phrase = `APPROVE ${review.reviewDigest}`;
    const answer = await runtime.question(`Type ${phrase} to sign and store this approval: `, lifetime.signal); active();
    if (answer !== phrase) declined = true;
    else {
      consentDigest = review.reviewDigest;
      const packet = await session.issue(review.reviewDigest, lifetime.signal); active();
      const expectedPacket = structuredClone(packet);
      checkSynchronous(keyCurrent); active();
      // Existing canonical intake only. Operator callback must not dispatch, call
      // a provider, retry signing, or treat receipt uncertainty as permission.
      const receipt = await store(structuredClone(packet), lifetime.signal); active();
      release.verifyPrivateOwnerStoredReceipt(target, expectedPacket, receipt);
      saved = true;
    }
  } catch { uncertain = true; }
  finally {
    consentDigest = undefined; lifetime.abort();
    try { session?.close(); } catch { uncertain = true; }
    try { if (releaseResources) await cleanup(releaseResources); else if (prepared) uncertain = true; }
    catch { uncertain = true; }
    clearTimeout(timer); runtime.signals.removeListener('SIGINT', stop); runtime.signals.removeListener('SIGTERM', stop);
  }
  if (uncertain) {
    runtime.reportError('Owner review did not confirm a clean stored result. No retry. Check canonical receipt and signer cleanup with the operator.');
    return 1;
  }
  runtime.report(saved ? 'Owner approval packet stored. Work has not been started by this command.'
    : declined ? 'Owner declined. Nothing signed or stored.' : 'Owner review closed.');
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await reviewPrivateOwnerTask(process.argv.slice(2)); }
  catch { console.error('Owner review command refused setup.'); process.exitCode = 1; }
}
