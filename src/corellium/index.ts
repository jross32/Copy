/**
 * Corellium client — main export
 *
 * Quick start:
 *
 *   import { createClient } from './corellium/index.js';
 *
 *   const client = createClient(); // reads CORELLIUM_API_TOKEN from env
 *
 *   const instances = await client.listInstances();
 *   const snap = await client.takeSnapshot(instanceId, { name: 'before-test' });
 *   await client.restoreSnapshot(instanceId, snap.id);
 */

export { CorelliumClient } from './client.js';
export * from './types.js';

import { CorelliumClient } from './client.js';

/**
 * Create a CorelliumClient from environment variables.
 *
 * Required env vars:
 *   CORELLIUM_API_TOKEN  — your API token from app.corellium.com
 *
 * Optional env vars:
 *   CORELLIUM_URL        — defaults to https://app.corellium.com
 */
export function createClient(): CorelliumClient {
  const apiToken = process.env.CORELLIUM_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      'Missing CORELLIUM_API_TOKEN environment variable.\n' +
      'Get your token at: https://app.corellium.com/profile/api'
    );
  }
  const apiUrl = process.env.CORELLIUM_URL ?? 'https://app.corellium.com';
  return new CorelliumClient({ apiUrl, apiToken });
}
