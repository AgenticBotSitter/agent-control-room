// Separate provisioning-only input. Never load from website startup or retain
// privileged credentials in the service's settings file.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validatePrivateVpsConfigurationPath } from '../scripts/run-private-vps.mjs';
export const schema = 'control-room.private-owner-bootstrap-configuration/v1';
export async function createConfiguration() {
  const path = process.env.CONTROL_ROOM_OWNER_BOOTSTRAP_FILE;
  if (!path || !isAbsolute(path)) throw new Error('owner_bootstrap_settings_required');
  await validatePrivateVpsConfigurationPath(path);
  return JSON.parse(await readFile(path, 'utf8'));
}
