#!/usr/bin/env node
/**
 * Corellium CLI
 *
 * Usage:
 *   export CORELLIUM_API_TOKEN=your_token
 *   export CORELLIUM_URL=https://app.corellium.com   # optional, this is the default
 *
 *   tsx src/corellium/cli.ts list
 *   tsx src/corellium/cli.ts create --name "iPhone 16 Research" --flavor iphone16pro --os 26.0 --project <project-id>
 *   tsx src/corellium/cli.ts start <instance-id>
 *   tsx src/corellium/cli.ts stop <instance-id>
 *   tsx src/corellium/cli.ts snapshot <instance-id> "before-exploit-attempt"
 *   tsx src/corellium/cli.ts restore <instance-id> <snapshot-id>
 *   tsx src/corellium/cli.ts snapshots <instance-id>
 *   tsx src/corellium/cli.ts console <instance-id>
 *   tsx src/corellium/cli.ts shell <instance-id> "ls /private/var/mobile"
 *   tsx src/corellium/cli.ts ls <instance-id> /private/var/mobile/
 *   tsx src/corellium/cli.ts pull <instance-id> <remote-path> [local-path]
 *   tsx src/corellium/cli.ts push <instance-id> <local-path> <remote-path>
 *   tsx src/corellium/cli.ts apps <instance-id>
 *   tsx src/corellium/cli.ts os <flavor>
 *   tsx src/corellium/cli.ts projects
 */

import { createClient } from './index.js';
import { CorelliumError } from './types.js';
import fs from 'fs/promises';
import path from 'path';
// ws is an optional dependency — imported dynamically only for the `console` command

const client = createClient();

function usage() {
  console.log(`
Corellium CLI — iOS research device control

ENVIRONMENT
  CORELLIUM_API_TOKEN   Required. Your Corellium API token.
  CORELLIUM_URL         Optional. Default: https://app.corellium.com

COMMANDS
  projects                          List all projects
  list                              List all virtual device instances
  create <options>                  Create a new virtual device
    --project <id>                  Project ID (required)
    --name    <name>                Device name (required)
    --flavor  <flavor>              Device model, e.g. iphone16pro
    --os      <version>             iOS version, e.g. 26.0
    --jailbroken                    Apply jailbroken patch (SRD research mode)
  delete <instance-id>              Delete an instance
  start  <instance-id>              Power on an instance
  stop   <instance-id>              Power off an instance
  reboot <instance-id>              Reboot an instance
  pause  <instance-id>              Pause (freeze) an instance
  wait   <instance-id> <state>      Wait until instance reaches a state

  snapshots <instance-id>           List snapshots
  snapshot  <instance-id> <name>    Take a new snapshot
  restore   <instance-id> <snap-id> Restore to a snapshot

  console <instance-id>             Stream serial console output (Ctrl+C to stop)
  shell   <instance-id> <cmd>       Run a shell command on the device
  ls      <instance-id> <path>      List files on the device
  pull    <instance-id> <remote> [local]   Download a file from the device
  push    <instance-id> <local> <remote>   Upload a file to the device

  apps    <instance-id>             List installed apps
  install <instance-id> <ipa-path>  Install an IPA

  os <flavor>                       List supported iOS versions for a flavor
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  try {
    switch (cmd) {

      // ── Projects ────────────────────────────────────────────────────────
      case 'projects': {
        const projects = await client.listProjects();
        console.log('\nProjects:');
        for (const p of projects) {
          console.log(`  ${p.id}  ${p.name}  (cores: ${p.quotasUsed.cores}/${p.quotas.cores})`);
        }
        break;
      }

      // ── List instances ───────────────────────────────────────────────────
      case 'list': {
        const instances = await client.listInstances();
        if (instances.length === 0) {
          console.log('No instances found.');
          break;
        }
        console.log('\nInstances:');
        for (const inst of instances) {
          const stateColor = inst.state === 'on' ? '\x1b[32m' : '\x1b[33m';
          console.log(
            `  ${inst.id}  ${inst.name.padEnd(30)} ${inst.flavor.padEnd(16)} ` +
            `iOS ${inst.os.padEnd(8)} ${stateColor}${inst.state}\x1b[0m`
          );
        }
        break;
      }

      // ── Create instance ─────────────────────────────────────────────────
      case 'create': {
        const flags = parseFlags(args.slice(1));
        if (!flags.project || !flags.name || !flags.flavor || !flags.os) {
          console.error('Usage: create --project <id> --name <name> --flavor <flavor> --os <version>');
          process.exit(1);
        }
        console.log(`Creating instance "${flags.name}" (${flags.flavor}, iOS ${flags.os})...`);
        const inst = await client.createInstance({
          projectId: flags.project,
          name: flags.name,
          flavor: flags.flavor,
          os: flags.os,
          patches: flags.jailbroken !== undefined ? ['jailbroken', 'corelliumd'] : ['corelliumd'],
        });
        console.log(`Created: ${inst.id} — waiting for it to boot...`);
        const ready = await client.waitForState(inst.id, 'on', 600_000);
        console.log(`✓ Instance is on: ${ready.id}  (wifi: ${ready.wifiIp ?? 'pending'})`);
        break;
      }

      // ── Delete instance ─────────────────────────────────────────────────
      case 'delete': {
        const id = requireArg(args[1], 'instance-id');
        await client.deleteInstance(id);
        console.log(`Deleted ${id}`);
        break;
      }

      // ── Power controls ───────────────────────────────────────────────────
      case 'start': {
        const id = requireArg(args[1], 'instance-id');
        await client.startInstance(id);
        console.log(`Starting ${id}...`);
        const inst = await client.waitForState(id, 'on');
        console.log(`✓ ${inst.name} is on`);
        break;
      }
      case 'stop': {
        const id = requireArg(args[1], 'instance-id');
        await client.stopInstance(id);
        console.log(`Stopping ${id}...`);
        const inst = await client.waitForState(id, 'off');
        console.log(`✓ ${inst.name} is off`);
        break;
      }
      case 'reboot': {
        const id = requireArg(args[1], 'instance-id');
        await client.rebootInstance(id);
        console.log(`Rebooting ${id}...`);
        await client.waitForState(id, 'on');
        console.log('✓ Rebooted');
        break;
      }
      case 'pause': {
        const id = requireArg(args[1], 'instance-id');
        await client.pauseInstance(id);
        console.log(`✓ Paused ${id}`);
        break;
      }
      case 'wait': {
        const id = requireArg(args[1], 'instance-id');
        const state = requireArg(args[2], 'state') as Instance['state'];
        console.log(`Waiting for ${id} to reach state '${state}'...`);
        const inst = await client.waitForState(id, state);
        console.log(`✓ ${inst.name} is now '${state}'`);
        break;
      }

      // ── Snapshots ────────────────────────────────────────────────────────
      case 'snapshots': {
        const id = requireArg(args[1], 'instance-id');
        const snaps = await client.listSnapshots(id);
        if (snaps.length === 0) {
          console.log('No snapshots found.');
          break;
        }
        console.log('\nSnapshots:');
        for (const s of snaps) {
          const fresh = s.fresh ? '(fresh)' : '';
          console.log(`  ${s.id}  ${s.name.padEnd(40)} ${s.status.value.padEnd(10)} ${s.created} ${fresh}`);
        }
        break;
      }
      case 'snapshot': {
        const id = requireArg(args[1], 'instance-id');
        const name = requireArg(args[2], 'snapshot name');
        console.log(`Taking snapshot "${name}"...`);
        const snap = await client.takeSnapshot(id, { name });
        console.log(`✓ Snapshot created: ${snap.id}`);
        break;
      }
      case 'restore': {
        const id = requireArg(args[1], 'instance-id');
        const snapId = requireArg(args[2], 'snapshot-id');
        console.log(`Restoring ${id} to snapshot ${snapId}...`);
        await client.restoreSnapshot(id, snapId);
        await client.waitForState(id, 'on');
        console.log('✓ Restored');
        break;
      }

      // ── Console (serial output stream) ───────────────────────────────────
      case 'console': {
        const id = requireArg(args[1], 'instance-id');
        const { url } = await client.getConsoleUrl(id);
        console.error(`[corellium] Connecting to console: ${url}`);
        console.error('[corellium] Streaming output — Ctrl+C to stop\n');

        // Dynamically import ws — install with: npm install ws
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let wsModule: any;
        try {
          wsModule = await import('ws');
        } catch {
          console.error(
            'Install ws to use this command: npm install ws\n' +
            `Console URL (connect manually): ${url}`
          );
          process.exit(1);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ws: any = new wsModule.default(url);
        ws.on('message', (data: Buffer) => process.stdout.write(data));
        ws.on('error', (err: Error) => console.error('[ws error]', err.message));
        ws.on('close', () => console.error('\n[corellium] Console disconnected'));

        process.on('SIGINT', () => {
          ws.close();
          process.exit(0);
        });

        // Keep alive
        await new Promise(() => {}); // wait forever until Ctrl+C
        break;
      }

      // ── Shell command ────────────────────────────────────────────────────
      case 'shell': {
        const id = requireArg(args[1], 'instance-id');
        const cmd2 = requireArg(args[2], 'command');
        const result = await client.runCommand(id, cmd2);
        process.stdout.write(result.output);
        if (result.status !== 0) process.exit(result.status);
        break;
      }

      // ── File listing ─────────────────────────────────────────────────────
      case 'ls': {
        const id = requireArg(args[1], 'instance-id');
        const dirPath = requireArg(args[2], 'path');
        const entries = await client.listFiles(id, dirPath);
        for (const entry of entries) {
          const size = entry.size != null ? String(entry.size).padStart(10) : '         -';
          const type = entry.type === 'directory' ? '\x1b[34m' : '';
          const name = entry.type === 'directory' ? entry.name + '/' : entry.name;
          console.log(`${size}  ${type}${name}\x1b[0m`);
        }
        break;
      }

      // ── File download ────────────────────────────────────────────────────
      case 'pull': {
        const id = requireArg(args[1], 'instance-id');
        const remotePath = requireArg(args[2], 'remote-path');
        const localPath = args[3] ?? path.basename(remotePath);
        console.log(`Downloading ${remotePath} → ${localPath} ...`);
        const data = await client.downloadFile(id, remotePath);
        await fs.writeFile(localPath, data);
        console.log(`✓ Saved ${data.byteLength} bytes to ${localPath}`);
        break;
      }

      // ── File upload ──────────────────────────────────────────────────────
      case 'push': {
        const id = requireArg(args[1], 'instance-id');
        const localPath = requireArg(args[2], 'local-path');
        const remotePath = requireArg(args[3], 'remote-path');
        const data = await fs.readFile(localPath);
        console.log(`Uploading ${localPath} → ${remotePath} ...`);
        await client.uploadFile(id, remotePath, new Uint8Array(data));
        console.log('✓ Uploaded');
        break;
      }

      // ── Apps ─────────────────────────────────────────────────────────────
      case 'apps': {
        const id = requireArg(args[1], 'instance-id');
        const apps = await client.listApps(id);
        if (apps.length === 0) { console.log('No apps installed.'); break; }
        console.log('\nInstalled Apps:');
        for (const app of apps) {
          console.log(`  ${app.bundleID.padEnd(50)} ${app.name}  v${app.version}`);
        }
        break;
      }
      case 'install': {
        const id = requireArg(args[1], 'instance-id');
        const ipaPath = requireArg(args[2], 'ipa-path');
        const data = await fs.readFile(ipaPath);
        console.log(`Installing ${path.basename(ipaPath)}...`);
        await client.installApp(id, new Uint8Array(data), path.basename(ipaPath));
        console.log('✓ Installed');
        break;
      }

      // ── Supported OS ─────────────────────────────────────────────────────
      case 'os': {
        const flavor = requireArg(args[1], 'flavor');
        const versions = await client.listSupportedOS(flavor);
        console.log(`\nSupported iOS versions for ${flavor}:`);
        for (const v of versions) {
          console.log(`  ${v.version.padEnd(12)} build: ${v.buildid}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof CorelliumError) {
      console.error(`\nError: ${err.message}`);
      if (err.body) console.error('Details:', JSON.stringify(err.body, null, 2));
    } else {
      throw err;
    }
    process.exit(1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    console.error(`Missing required argument: <${name}>`);
    process.exit(1);
  }
  return value!;
}

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      result[key] = val;
    }
  }
  return result;
}

// Allow "state" to be used as a type in the wait command
type Instance = import('./types.js').Instance;

main().catch(err => {
  console.error(err);
  process.exit(1);
});
