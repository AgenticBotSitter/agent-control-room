#!/usr/bin/env node
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
import { isRehearsalHostnameV1 } from "../../src/installer/shared/rehearsal-hostname.mjs";
import { readFile, open, link, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isMainModuleV1 } from '../../src/installer/shared/is-main-module.mjs';

const fields = ['releaseCommit', 'stagingFolder', 'livePorts', 'liveLabelPrefixes', 'rehearsalTailnetName', 'repoSlug', 'postgresql'];
const refuse = code => { throw new Error(code); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const description = value => `: ${quote(value)}`;
const read = path => readFile(new URL(path, import.meta.url), 'utf8');

export async function makeOwnerPasteFile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) refuse('input_fields_refused');
  if (typeof input.releaseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(input.releaseCommit)) refuse('release_commit_refused');
  if (typeof input.stagingFolder !== 'string' || input.stagingFolder.length > 4095 || input.stagingFolder.endsWith('/')
    || !isAbsolute(input.stagingFolder) || normalize(input.stagingFolder) !== input.stagingFolder
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(input.stagingFolder)) refuse('staging_folder_refused');
  if (!Array.isArray(input.livePorts) || !input.livePorts.length || new Set(input.livePorts).size !== input.livePorts.length || input.livePorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) refuse('live_ports_refused');
  if (!Array.isArray(input.liveLabelPrefixes) || !input.liveLabelPrefixes.length || new Set(input.liveLabelPrefixes.map(label => typeof label === 'string' ? label.toLowerCase() : label)).size !== input.liveLabelPrefixes.length || input.liveLabelPrefixes.some(label => typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(label))) refuse('live_labels_refused');
  if (!isRehearsalHostnameV1(input.rehearsalTailnetName)) refuse('rehearsal_tailnet_refused');
  if (typeof input.repoSlug !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(input.repoSlug)) refuse('repo_slug_refused');
  if (input.postgresql !== undefined && (!input.postgresql || typeof input.postgresql !== 'object'
    || Object.keys(input.postgresql).sort().join(',') !== 'executable,sha256'
    || typeof input.postgresql.executable !== 'string' || !isAbsolute(input.postgresql.executable)
    || normalize(input.postgresql.executable) !== input.postgresql.executable || !input.postgresql.executable.endsWith('/postgres')
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(input.postgresql.executable)
    || !/^[a-f0-9]{64}$/u.test(input.postgresql.sha256 ?? ''))) refuse('postgresql_identity_refused');
  const kit = await read('../../docs/install/E2E2_REHEARSAL.md');
  const owner = await read('../../docs/INSTALL_NIGHT_OWNER_GUIDE.md');
  const commands = kit.split('## Commands, in order')[1]?.split('## Exact C6 installer contract')[0];
  if (!commands) refuse('guide_structure_refused');
  const sections = [...commands.matchAll(/### (\d+)\. ([^\n]+)\n([\s\S]*?)(?=\n### |$)/gu)];
  if (sections.length !== 11) refuse('guide_structure_refused');
  const descriptions = [
    'Quit the Claude app and the ChatGPT app (Cmd-Q), then check all bots are stopped; continue only after PASS.',
    'Check the staged repository and save the live snapshot; expect the reviewed repository, a printed checksum, and unchanged Serve and hostname.',
    'Create a private working folder; write down the printed paths.',
    'Generate the isolated rehearsal identity; expect the same checksum and no missing installer flags.',
    'Check the installer safety contract; expect PASS with no Tailscale mutation.',
    'Save the before snapshot; write down its path and expect Serve and hostname unchanged.',
    'Practice the install; the installer asks for the token, paste it from your password manager; expect three healthy samples.',
    'Collect the practice evidence; every row and Overall must say PASS.',
    'Remove only the practice install; expect a retained rehearsal folder.',
    'Compare the Mac with its starting state; expect an empty system diff and Serve and hostname unchanged.',
    'Only after every rehearsal result passes and the lead confirms, quit Claude and ChatGPT again and install for real; the installer asks for the token, paste it from your password manager; expect Ready, then sign in on the Mac.',
  ];
  function fill(code) {
    // A FUNCTION replacer is what keeps a staging path containing `$&`, `$`, `$' or `$$` from
    // being expanded: with a string replacement those tokens splice other parts of the kit (or
    // the whole tail of this document) into every quoted path. The kit's own literal text is
    // also the search, so nothing here can match a placeholder we have not named.
    const literal = (marker, value) => code => code.replaceAll(marker, () => quote(value));
    // r5sfix: the stopped-bots check also receives the PostgreSQL program it may allow.
    const postgres = input.postgresql ? ` --postgres-executable ${quote(input.postgresql.executable)} --postgres-sha256 ${quote(input.postgresql.sha256)}` : '';
    const check = '"$NODE_BIN" "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs"';
    return [
      code => code.replaceAll(`${check} ||`, () => `${check}${postgres} ||`),
      code => code.replaceAll(`${check} --password-handoff ||`, () => `${check} --password-handoff${postgres} ||`),
      literal("'/Users/Shared/control-room-e2e2/node/bin/node'", `${input.stagingFolder}/node/bin/node`),
      literal("'/Users/Shared/control-room-e2e2/source'", `${input.stagingFolder}/source`),
      literal("'/Users/Shared/control-room-e2e2/owner-live-snapshot.json'", `${input.stagingFolder}/owner-live-snapshot.json`),
      literal("'COMMIT40'", input.releaseCommit),
      literal("'LIVE_PORTS'", input.livePorts.join(',')),
      literal("'LIVE_LABEL_PREFIXES'", input.liveLabelPrefixes.join(',')),
      literal("'REHEARSAL_TAILNET'", input.rehearsalTailnetName),
      code => code.replaceAll("  LIVE_SNAPSHOT_SHA256='LIVE_SNAPSHOT_SHA256'\n", () => ''),
      literal("'LIVE_SNAPSHOT_SHA256'", '"$LIVE_SNAPSHOT_SHA256"'),
    ].reduce((text, step) => step(text), code);
  }
  const blocks = sections.map((section, index) => {
    const codes = [...section[3].matchAll(/```sh\n([\s\S]*?)```/gu)].map(match => fill(match[1].trimEnd()));
    if (index === 10) codes.push(fill(owner.match(/```sh\n([\s\S]*?)```/u)?.[1]?.trimEnd() ?? refuse('guide_structure_refused')));
    if (!codes.length) refuse('guide_structure_refused');
    if (index === 1) {
      codes[0] = codes[0].replace(/\nowner_snapshot_step$/u, `\nowner_snapshot_step || return 1\nLIVE_SNAPSHOT_SHA256="$(/usr/bin/shasum -a 256 "$LIVE_SNAPSHOT")" || { printf '%s\\n' 'STOP: checksum capture failed; show the lead after reopening Claude.'; return 1; }\nLIVE_SNAPSHOT_SHA256="\${LIVE_SNAPSHOT_SHA256%% *}"`);
      codes.unshift(`staging_check_step() {
  NODE_BIN=${quote(`${input.stagingFolder}/node/bin/node`)}
  KIT_ROOT=${quote(`${input.stagingFolder}/source`)}
  EXPECTED_REMOTE=${quote(`https://github.com/${input.repoSlug}.git`)}
  test "$(/usr/bin/git -c safe.directory="$KIT_ROOT" -C "$KIT_ROOT" remote get-url origin 2>/dev/null)" = "$EXPECTED_REMOTE" || {
    printf '%s\\n' 'STOP: staged repository does not match; show the lead after reopening Claude.'; return 1;
  }
  "$NODE_BIN" -e 'const fs=require("node:fs");const s=fs.readFileSync(process.argv[1],"utf8");if(!s.includes("REMOTE_URL="+String.fromCharCode(39)+process.argv[2]+String.fromCharCode(39)))process.exit(1)' "$KIT_ROOT/scripts/install-night/bootstrap.sh" "$EXPECTED_REMOTE" || {
    printf '%s\\n' 'STOP: bootstrap repository does not match; show the lead after reopening Claude.'; return 1;
  }
}
staging_check_step`);
    }
    // These read-only gates appear in prose between the guide's command blocks.
    if ([5, 6, 7, 8, 9].includes(index)) codes.push('serve_check');
    const body = codes.join('\n\n').replace(/^([a-z_]+_step|serve_check)$/gmu, '$1 || return 1');
    const guidance = index === 6
      ? section[3].split('Good, in order')[1]?.split('Mandatory stop immediately')[0]
      : index === 10 ? owner.split('\n1. After the lead checks')[1]?.split('## After install: connect your bots')[0] : '';
    if ([6, 10].includes(index) && !guidance) refuse('guide_structure_refused');
    const notes = guidance ? ('Read before pasting: ' + (index === 6 ? 'Good, in order' : '1. After the lead checks') + guidance)
      .trim().split('\n').map(line => description(`   ${line}`)).join('\n') + '\n' : '';
    return `${description(`${index + 1}. ${descriptions[index]}`)}\n${notes}paste_block_${index + 1}() {\n${body}\n}\npaste_block_${index + 1}\n`;
  });
  const connect = owner.split('## After install: connect your bots\n')[1];
  if (!connect?.includes('### Run one small test task')) refuse('guide_structure_refused');
  blocks.push(description('12. After install: connect your bots (read-only instructions; do not paste; no saved enrollment codes).') + '\n'
    + connect.trim().split('\n').map(line => description(`   ${line}`)).join('\n') + '\n');
  const introduction = [
    'Install night: use Apple Terminal in your normal account. The lead must stage the reviewed source (including .git) and Node first.',
    'Paste one numbered block at a time in this same Terminal. Stop on any error or STOP message; do not retry. Copy the last Terminal lines into a note and show the lead after reopening Claude. Keep this file private.',
    'Before the password step, quit the Claude app and the ChatGPT app (Cmd-Q). The lead is unavailable until Ready or rollback. Keep printed paths and checksum.',
    'If Terminal closes, do not retry. Save the last available lines and show the lead after reopening Claude.',
  ];
  return introduction.map(description).join('\n') + '\n\n' + blocks.join('\n');
}

export async function writePasteFile(output, content, signal) {
  if (!isAbsolute(output) || normalize(output) !== output || await realpathSafe(dirname(output)) !== dirname(output)) refuse('output_path_refused');
  const temporary = `${output}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, { signal });
    await handle.sync();
    await link(temporary, output);
  } finally { await handle.close(); await unlink(temporary); }
}

async function realpathSafe(path) {
  try { return await realpath(path); } catch { refuse('output_path_refused'); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output') refuse('arguments_refused');
  const input = parseStrictJsonV1(await readFile(argv[1], 'utf8'));
  const content = await makeOwnerPasteFile(input);
  await writePasteFile(argv[3], content);
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(() => { process.stderr.write('Paste file refused; check inputs, staged repository, and unused output path.\n'); process.exitCode = 1; });
}
