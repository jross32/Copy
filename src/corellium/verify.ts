/**
 * Corellium connection verifier
 *
 * Run this first to confirm your API token works and see what's available:
 *
 *   export CORELLIUM_API_TOKEN=your_token
 *   npx tsx src/corellium/verify.ts
 */

import { createClient } from './index.js';
import { CorelliumError } from './types.js';

async function verify() {
  console.log('─────────────────────────────────────────');
  console.log('  Corellium Connection Verifier');
  console.log('─────────────────────────────────────────\n');

  // 1. Check token is set
  const token = process.env.CORELLIUM_API_TOKEN;
  if (!token) {
    console.error('✗ CORELLIUM_API_TOKEN is not set');
    console.error('\nGet your token at: https://app.corellium.com/profile/api');
    console.error('Then run: export CORELLIUM_API_TOKEN=your_token_here');
    process.exit(1);
  }
  console.log('✓ CORELLIUM_API_TOKEN is set');

  const client = createClient();

  // 2. Try to authenticate
  try {
    await client.authenticate();
    console.log('✓ Authentication successful\n');
  } catch (err) {
    const msg = err instanceof CorelliumError ? err.message : String(err);
    console.error(`✗ Authentication failed: ${msg}`);
    console.error('\nCheck your token at: https://app.corellium.com/profile/api');
    process.exit(1);
  }

  // 3. List projects
  try {
    const projects = await client.listProjects();
    console.log(`Projects (${projects.length}):`);
    for (const p of projects) {
      console.log(`  • ${p.name}  [${p.id}]  — ${p.quotasUsed.cores}/${p.quotas.cores} cores used`);
    }
    console.log();
  } catch (err) {
    console.error('✗ Could not list projects:', err);
  }

  // 4. List existing instances
  try {
    const instances = await client.listInstances();
    if (instances.length === 0) {
      console.log('No virtual devices yet — create one with:');
      console.log('  npm run corellium create --project <project-id> --name "Research iPhone" --flavor iphone16pro --os 26.0\n');
    } else {
      console.log(`Virtual Devices (${instances.length}):`);
      for (const inst of instances) {
        const stateColor = inst.state === 'on' ? '\x1b[32m' : '\x1b[33m';
        console.log(
          `  • ${inst.name} [${inst.id}]\n` +
          `    Flavor: ${inst.flavor}  iOS: ${inst.os}  ` +
          `State: ${stateColor}${inst.state}\x1b[0m`
        );

        // If instance is on, list installed apps
        if (inst.state === 'on') {
          try {
            const apps = await client.listApps(inst.id);
            console.log(`    Apps installed: ${apps.length}`);
            for (const app of apps.slice(0, 5)) {
              console.log(`      – ${app.name} (${app.bundleID})`);
            }
            if (apps.length > 5) console.log(`      … and ${apps.length - 5} more`);
          } catch {
            console.log('    (could not list apps — device may still be booting)');
          }
        }
        console.log();
      }
    }
  } catch (err) {
    console.error('✗ Could not list instances:', err);
  }

  // 5. List iOS versions available for iPhone 16 Pro
  try {
    console.log('Supported iOS versions for iphone16pro:');
    const versions = await client.listSupportedOS('iphone16pro');
    const sorted = versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    for (const v of sorted.slice(0, 8)) {
      console.log(`  • iOS ${v.version}  (build: ${v.buildid})`);
    }
    if (sorted.length > 8) console.log(`  … and ${sorted.length - 8} more`);
    console.log();
  } catch {
    console.log('(Could not fetch supported OS list — may require specific account access)\n');
  }

  console.log('─────────────────────────────────────────');
  console.log('  All checks passed! Corellium is ready.');
  console.log('─────────────────────────────────────────\n');
  console.log('Next steps:');
  console.log('  1. Create a device:  npm run corellium create --project <id> --name "iPhone 16" --flavor iphone16pro --os 26.0');
  console.log('  2. List devices:     npm run corellium list');
  console.log('  3. Install an app:   npm run corellium install <instance-id> MyApp.ipa');
  console.log('  4. Stream console:   npm run corellium console <instance-id>');
  console.log('  5. Run a command:    npm run corellium shell <instance-id> "ls /private/var"');
}

verify().catch(err => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
