/**
 * Corellium API Client
 *
 * Provides programmatic control over virtual iOS devices on Corellium —
 * useful for iOS security research (snapshot/restore, console access,
 * file extraction, app installation, etc.)
 *
 * API docs: https://developer.corellium.com/
 */

import {
  CorelliumConfig,
  CorelliumError,
  AuthResponse,
  Project,
  Instance,
  CreateInstanceOptions,
  Snapshot,
  CreateSnapshotOptions,
  InstalledApp,
  SupportedOS,
  FileEntry,
} from './types.js';

export class CorelliumClient {
  private baseUrl: string;
  private apiToken: string;
  private jwtToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(config: CorelliumConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Authenticate with the Corellium API and get a JWT.
   * Called automatically before requests — you don't need to call this manually.
   */
  async authenticate(): Promise<void> {
    const res = await this.rawFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiToken: this.apiToken }),
    });
    const data = res as AuthResponse;
    this.jwtToken = data.token;
    this.tokenExpiry = new Date(data.expiration);
    console.error(`[corellium] Authenticated. Token expires: ${data.expiration}`);
  }

  private isTokenValid(): boolean {
    if (!this.jwtToken || !this.tokenExpiry) return false;
    // Refresh if less than 5 minutes remain
    return this.tokenExpiry.getTime() - Date.now() > 5 * 60 * 1000;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
  }

  // ─── HTTP Helpers ─────────────────────────────────────────────────────────

  private async rawFetch(path: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    };

    const res = await fetch(url, { ...options, headers });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      throw new CorelliumError(
        `Corellium API error ${res.status}: ${res.statusText}`,
        res.status,
        body
      );
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return null;
    }

    return res.json();
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<unknown> {
    await this.ensureAuth();
    return this.rawFetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.jwtToken}`,
        ...(options.headers as Record<string, string>),
      },
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.fetch(path) as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.fetch(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }) as Promise<T>;
  }

  private async del(path: string): Promise<void> {
    await this.fetch(path, { method: 'DELETE' });
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  /** List all projects in your Corellium account */
  async listProjects(): Promise<Project[]> {
    return this.get<Project[]>('/api/v1/projects?teamRoles=true');
  }

  /** Get a specific project by ID */
  async getProject(projectId: string): Promise<Project> {
    return this.get<Project>(`/api/v1/projects/${projectId}`);
  }

  // ─── Instances (Virtual Devices) ─────────────────────────────────────────

  /** List all virtual device instances */
  async listInstances(): Promise<Instance[]> {
    return this.get<Instance[]>('/api/v1/instances');
  }

  /** Get a specific instance by ID */
  async getInstance(instanceId: string): Promise<Instance> {
    return this.get<Instance>(`/api/v1/instances/${instanceId}`);
  }

  /**
   * Create a new virtual iOS device.
   *
   * @example
   * await client.createInstance({
   *   projectId: 'your-project-id',
   *   name: 'iPhone 16 Research',
   *   flavor: 'iphone16pro',
   *   os: '26.0',
   *   patches: ['jailbroken'],  // enables SRD-style research mode
   * });
   */
  async createInstance(opts: CreateInstanceOptions): Promise<Instance> {
    return this.post<Instance>('/api/v1/instances', {
      project: opts.projectId,
      name: opts.name,
      flavor: opts.flavor,
      os: opts.os,
      patches: opts.patches ?? ['corelliumd'],
    });
  }

  /** Delete an instance permanently */
  async deleteInstance(instanceId: string): Promise<void> {
    return this.del(`/api/v1/instances/${instanceId}`);
  }

  // ─── Instance Power Controls ──────────────────────────────────────────────

  /** Power on a stopped instance */
  async startInstance(instanceId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/start`);
  }

  /** Power off a running instance */
  async stopInstance(instanceId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/stop`);
  }

  /** Reboot a running instance */
  async rebootInstance(instanceId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/reboot`);
  }

  /** Pause a running instance (freeze state, save CPU) */
  async pauseInstance(instanceId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/pause`);
  }

  /** Resume a paused instance */
  async unpauseInstance(instanceId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/unpause`);
  }

  /**
   * Wait for an instance to reach a target state.
   * Polls every 5 seconds up to the timeout.
   */
  async waitForState(
    instanceId: string,
    targetState: Instance['state'],
    timeoutMs = 300_000
  ): Promise<Instance> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const instance = await this.getInstance(instanceId);
      if (instance.state === targetState) return instance;
      if (instance.state === 'error') {
        throw new CorelliumError(`Instance entered error state while waiting for '${targetState}'`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new CorelliumError(
      `Timed out waiting for instance ${instanceId} to reach state '${targetState}'`
    );
  }

  // ─── Snapshots ────────────────────────────────────────────────────────────

  /** List all snapshots for an instance */
  async listSnapshots(instanceId: string): Promise<Snapshot[]> {
    return this.get<Snapshot[]>(`/api/v1/instances/${instanceId}/snapshots`);
  }

  /**
   * Take a snapshot of the current instance state.
   * Use this before running any exploit so you can roll back.
   */
  async takeSnapshot(instanceId: string, opts: CreateSnapshotOptions): Promise<Snapshot> {
    return this.post<Snapshot>(`/api/v1/instances/${instanceId}/snapshots`, opts);
  }

  /**
   * Restore an instance to a previously saved snapshot.
   * Useful after a kernel panic or crashed exploit attempt.
   */
  async restoreSnapshot(instanceId: string, snapshotId: string): Promise<void> {
    await this.post(`/api/v1/instances/${instanceId}/snapshots/${snapshotId}/restore`);
  }

  /** Delete a snapshot */
  async deleteSnapshot(instanceId: string, snapshotId: string): Promise<void> {
    await this.del(`/api/v1/instances/${instanceId}/snapshots/${snapshotId}`);
  }

  // ─── Apps ─────────────────────────────────────────────────────────────────

  /** List installed apps on the instance */
  async listApps(instanceId: string): Promise<InstalledApp[]> {
    return this.get<InstalledApp[]>(`/api/v1/instances/${instanceId}/apps`);
  }

  /**
   * Install an IPA file on the virtual device.
   * Provide the IPA as a Buffer or Uint8Array.
   */
  async installApp(instanceId: string, ipaData: Uint8Array, filename = 'app.ipa'): Promise<void> {
    await this.ensureAuth();

    const form = new FormData();
    form.append('file', new Blob([ipaData.buffer as ArrayBuffer], { type: 'application/octet-stream' }), filename);

    const res = await fetch(`${this.baseUrl}/api/v1/instances/${instanceId}/apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.jwtToken}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new CorelliumError(`Failed to install app: ${res.statusText}`, res.status, body);
    }
  }

  // ─── Console ──────────────────────────────────────────────────────────────

  /**
   * Get the serial console WebSocket URL for an instance.
   * Connect with any WebSocket client to see raw kernel output,
   * boot messages, and kernel panics in real time.
   *
   * @example
   * const { url } = await client.getConsoleUrl(instanceId);
   * const ws = new WebSocket(url);
   * ws.on('message', data => process.stdout.write(data));
   */
  async getConsoleUrl(instanceId: string): Promise<{ url: string }> {
    return this.get<{ url: string }>(`/api/v1/instances/${instanceId}/console`);
  }

  // ─── File Agent ───────────────────────────────────────────────────────────

  /**
   * List files/directories on the virtual device (via Corellium's file agent).
   * Path should be an absolute iOS path, e.g. '/private/var/mobile/'.
   */
  async listFiles(instanceId: string, path: string): Promise<FileEntry[]> {
    const encoded = encodeURIComponent(path);
    return this.get<FileEntry[]>(
      `/api/v1/instances/${instanceId}/agent/v1/file/list?path=${encoded}`
    );
  }

  /**
   * Download a file from the virtual device.
   * Returns raw bytes — save to disk or process directly.
   *
   * @example
   * // Pull a Fallout Shelter save
   * const data = await client.downloadFile(
   *   instanceId,
   *   '/private/var/mobile/Containers/Data/Application/.../Documents/Vault1.sav'
   * );
   * await fs.writeFile('Vault1.sav', data);
   */
  async downloadFile(instanceId: string, remotePath: string): Promise<Uint8Array> {
    await this.ensureAuth();
    const encoded = encodeURIComponent(remotePath);
    const res = await fetch(
      `${this.baseUrl}/api/v1/instances/${instanceId}/agent/v1/file/download?path=${encoded}`,
      { headers: { Authorization: `Bearer ${this.jwtToken}` } }
    );
    if (!res.ok) {
      throw new CorelliumError(`Failed to download file: ${res.statusText}`, res.status);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Upload a file to the virtual device.
   */
  async uploadFile(instanceId: string, remotePath: string, data: Uint8Array): Promise<void> {
    await this.ensureAuth();
    const encoded = encodeURIComponent(remotePath);
    const res = await fetch(
      `${this.baseUrl}/api/v1/instances/${instanceId}/agent/v1/file/upload?path=${encoded}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.jwtToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: data as unknown as BodyInit,
      }
    );
    if (!res.ok) {
      throw new CorelliumError(`Failed to upload file: ${res.statusText}`, res.status);
    }
  }

  // ─── Supported OS Versions ────────────────────────────────────────────────

  /**
   * List iOS versions supported by Corellium for a given device flavor.
   */
  async listSupportedOS(flavor: string): Promise<SupportedOS[]> {
    return this.get<SupportedOS[]>(`/api/v1/supported?flavor=${encodeURIComponent(flavor)}`);
  }

  // ─── Agent Shell Execution ────────────────────────────────────────────────

  /**
   * Run a shell command on the virtual device via Corellium's agent.
   * Returns stdout/stderr as strings.
   *
   * @example
   * const { output } = await client.runCommand(instanceId, 'ls /private/var/mobile/');
   */
  async runCommand(
    instanceId: string,
    command: string
  ): Promise<{ output: string; status: number }> {
    const result = await this.post<{ output: string; status: number }>(
      `/api/v1/instances/${instanceId}/agent/v1/system/shellexec`,
      { cmd: command }
    );
    return result;
  }
}
