// Corellium API Types

export interface CorelliumConfig {
  apiUrl: string;       // e.g. https://app.corellium.com
  apiToken: string;     // Your Corellium API token
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthResponse {
  token: string;
  expiration: string;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  quotas: {
    cores: number;
  };
  quotasUsed: {
    cores: number;
  };
}

// ─── Instances (Virtual Devices) ─────────────────────────────────────────────

export type InstanceState =
  | 'on'
  | 'off'
  | 'paused'
  | 'creating'
  | 'deleting'
  | 'booting'
  | 'error';

export interface Instance {
  id: string;
  name: string;
  flavor: string;     // e.g. "iphone16pro"
  os: string;         // e.g. "26.0"
  state: InstanceState;
  project: string;
  bootOptions?: {
    bootArgs?: string;
    restoreBootArgs?: string;
    udid?: string;
    ecid?: string;
  };
  serviceIp?: string;
  wifiIp?: string;
  activeSnapshotId?: string;
}

export interface CreateInstanceOptions {
  projectId: string;
  name: string;
  flavor: DeviceFlavor;
  os: string;          // iOS version string, e.g. "26.0"
  patches?: InstancePatch[];
}

export type DeviceFlavor =
  | 'iphone16pro'
  | 'iphone16pro-max'
  | 'iphone16'
  | 'iphone16-plus'
  | 'iphone15pro'
  | 'iphone15pro-max'
  | 'iphone15'
  | 'iphone15-plus'
  | 'ipad-pro-7th-gen'
  | string; // allow arbitrary flavor strings

export type InstancePatch =
  | 'jailbroken'       // SRD/research device mode
  | 'corelliumd'       // Corellium agent
  | 'noSandbox'        // Disable app sandbox
  | 'noTraceV'
  | string;

// ─── Snapshots ───────────────────────────────────────────────────────────────

export interface Snapshot {
  id: string;
  name: string;
  created: string;    // ISO timestamp
  fresh: boolean;     // true = clean/unmodified state
  status: {
    value: 'creating' | 'live' | 'corrupt';
  };
  localCopy?: boolean;
}

export interface CreateSnapshotOptions {
  name: string;
}

// ─── Apps ────────────────────────────────────────────────────────────────────

export interface InstalledApp {
  applicationType: string;
  bundleID: string;
  name: string;
  version: string;
  iconURL?: string;
}

// ─── Console / Network ───────────────────────────────────────────────────────

export interface ConsoleInfo {
  url: string;  // WebSocket URL for serial console
}

export interface AgentInfo {
  info: {
    udid?: string;
    ipsw?: string;
  };
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: string;
}

// ─── OS Versions ─────────────────────────────────────────────────────────────

export interface SupportedOS {
  version: string;
  buildid: string;
  uniqueID: string;
  platform: string;
  flavor: string;
}

// ─── API Error ───────────────────────────────────────────────────────────────

export class CorelliumError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public body?: unknown
  ) {
    super(message);
    this.name = 'CorelliumError';
  }
}
