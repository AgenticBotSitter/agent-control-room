// Restricted website, optionally with saved Idea/news data. No runtime or worker.
// Keep this file in deploy/ within the pinned release and chmod 0600 on the server.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validatePrivateVpsConfigurationPath } from '../scripts/run-private-vps.mjs';
import { createAccessKeyLoader, validatePrivateStartupConfiguration } from '../dist-vps/server/bootstrap.js';
import { validatePrivateIdeaAuthoringConfiguration } from '../dist-vps/server/ideaAuthoring.js';

export const schema = 'control-room.private-vps-configuration/v1';
export async function createConfiguration({ signal }) {
  if (signal.aborted) throw new Error('operator_setup_canceled');
  const path = process.env.CONTROL_ROOM_SETTINGS_FILE;
  if (!path || !isAbsolute(path)) throw new Error('operator_settings_required');
  await validatePrivateVpsConfigurationPath(path);
  const settings = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
  if (!settings || !['port,web', 'port,savedViews,web', 'ideaAuthoring,port,savedViews,web'].includes(Object.keys(settings).sort().join(','))
    || !Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535)
    throw new Error('operator_settings_invalid');
  const expected = ['audience', 'database', 'issuer', 'maxSessionSeconds', 'origin',
    'ownerIdentityId', 'tenantId', 'workspaceId'].sort().join(',');
  if (!settings.web || Object.keys(settings.web).sort().join(',') !== expected)
    throw new Error('operator_settings_invalid');
  const optional = {};
  if ('savedViews' in settings) {
    const saved = settings.savedViews;
    if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !Object.keys(saved).length
      || Object.keys(saved).some(name => !['ideaIntegrityKeyHex', 'newsIntegrityKeyHex'].includes(name)))
      throw new Error('operator_settings_invalid');
    for (const [name, value] of Object.entries(saved)) {
      if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('operator_settings_invalid');
      optional[name === 'ideaIntegrityKeyHex' ? 'ideaProjects' : 'news'] = { integrityKey: Uint8Array.from(Buffer.from(value, 'hex')) };
    }
  }
  const web = validatePrivateStartupConfiguration({ ...settings.web,
    ...optional,
    loadKeys: createAccessKeyLoader(settings.web.issuer, fetch) });
  const configuration = 'ideaAuthoring' in settings
    ? validatePrivateIdeaAuthoringConfiguration({ web, ideaAuthoring: settings.ideaAuthoring }) : { web };
  return { mode: 'website-only', port: settings.port, configuration };
}
