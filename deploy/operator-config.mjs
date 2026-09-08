// Initial restricted website only. Import is inert; the launcher calls this explicitly.
// Keep this file in deploy/ within the pinned release and chmod 0600 on the server.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validatePrivateVpsConfigurationPath } from '../scripts/run-private-vps.mjs';
import { createAccessKeyLoader, validatePrivateStartupConfiguration } from '../dist-vps/server/bootstrap.js';

export const schema = 'control-room.private-vps-configuration/v1';
export async function createConfiguration({ signal }) {
  if (signal.aborted) throw new Error('operator_setup_canceled');
  const path = process.env.CONTROL_ROOM_SETTINGS_FILE;
  if (!path || !isAbsolute(path)) throw new Error('operator_settings_required');
  await validatePrivateVpsConfigurationPath(path);
  const settings = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
  if (!settings || Object.keys(settings).sort().join(',') !== 'port,web'
    || !Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535)
    throw new Error('operator_settings_invalid');
  const expected = ['audience', 'database', 'issuer', 'maxSessionSeconds', 'origin',
    'ownerIdentityId', 'tenantId', 'workspaceId'].sort().join(',');
  if (!settings.web || Object.keys(settings.web).sort().join(',') !== expected)
    throw new Error('operator_settings_invalid');
  const web = validatePrivateStartupConfiguration({ ...settings.web,
    loadKeys: createAccessKeyLoader(settings.web.issuer, fetch) });
  return { mode: 'website-only', port: settings.port, configuration: { web } };
}
