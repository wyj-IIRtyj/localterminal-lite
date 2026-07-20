import express, { type Express, type Request, type Response } from 'express';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildOpenApi } from './openapi.js';
import { createBuiltinTools } from './core-tools.js';
import { ExtensionService } from './extensions.js';
import { LiteMcpTransport } from './mcp.js';
import { ClusterExtensionRouter } from './cluster-router.js';
import { safeEqual } from './security.js';
import { LiteStore } from './store.js';
import { activeWorkspaceRuntimePids, appendWorkspaceLog, workspaceId } from './instances.js';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { PortClusterRegistry, tokenHash, type ClusterMember } from './cluster.js';
import { CLUSTER_PROTOCOL_VERSION, CURRENT_VERSION } from './update.js';
import { commandPassiveLock, disarmAllSessionResources, passiveLockStatus, reapSessionResources, startPassiveLockService } from './session-resources.js';
import type { LiteConfig, ToolResponse } from './types.js';

export type RuntimeLog = { at: string; level: 'info' | 'error'; message: string };

/**
 * Process-scoped composition root for one workspace.
 *
 * Ownership boundaries:
 * - owns workspace-local HTTP/MCP servers, timers, store, and runtime lease;
 * - participates in, but does not exclusively own, a shared-port cluster;
 * - may command the installation-global passive-lock helper, but may stop it
 *   only after global process liveness reaches zero.
 */
export class LiteRuntime {
  readonly store: LiteStore;
  readonly extensions: ExtensionService;
  readonly app: Express;
  readonly logs: RuntimeLog[] = [];
  private readonly mcp: LiteMcpTransport;
  private clusterMcp?: LiteMcpTransport;
  private clusterRouter?: ClusterExtensionRouter;
  private readonly internalServer: http.Server;
  private publicServer?: http.Server;
  private address?: AddressInfo;
  private internalAddress?: AddressInfo;
  private cluster?: PortClusterRegistry;
  private clusterMember?: ClusterMember;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private electionTimer?: ReturnType<typeof setInterval>;
  readonly workspaceCatalog: WorkspaceCatalog;

  constructor(readonly config: LiteConfig) {
    this.workspaceCatalog = WorkspaceCatalog.fromConfig(config);
    reapSessionResources(config);
    this.store = new LiteStore(config.stateDir);
    const builtins = createBuiltinTools(config, this.store);
    this.extensions = new ExtensionService(config, this.store, builtins);
    this.mcp = new LiteMcpTransport(this.extensions);
    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '256kb' }));
    this.internalServer = http.createServer(this.app);
    this.configureRoutes();
  }

  get port(): number {
    return this.address?.port ?? this.config.port;
  }

  clusterVersions(): string[] {
    if (!this.cluster) return [CURRENT_VERSION];
    const state = this.cluster.ensureRegistered();
    return [...new Set(state.members.filter((item) => {
      try { process.kill(item.pid, 0); return true; } catch { return false; }
    }).map((item) => item.appVersion))].sort();
  }

  clusterMemberCount(): number {
    const topology = this.processTopology();
    if (topology.mode === 'degraded' || topology.memberCount === undefined) {
      throw new Error(topology.error || 'Cluster topology is unavailable.');
    }
    return topology.memberCount;
  }

  /** Return persisted process topology after enforcing local membership. */
  processTopology(): {
    mode: 'single-workspace' | 'shared-port' | 'degraded';
    sharedPort: number;
    memberCount?: number;
    role: 'standalone' | 'leader' | 'member' | 'unknown';
    pid: number;
    error?: string;
  } {
    if (!this.cluster) {
      return { mode: 'single-workspace', sharedPort: this.port, memberCount: 1, role: 'standalone', pid: process.pid };
    }
    try {
      const state = this.cluster.ensureRegistered();
      const liveMembers = state.members.filter((member) => {
        try { process.kill(member.pid, 0); return true; } catch { return false; }
      });
      const local = liveMembers.find((member) => member.id === this.cluster!.memberId);
      if (!local) throw new Error('Local cluster membership could not be restored.');
      const isLeader = this.publicServer?.listening || state.leaderId === local.id;
      return {
        mode: liveMembers.length === 1 ? 'single-workspace' : 'shared-port',
        sharedPort: state.port,
        memberCount: liveMembers.length,
        role: liveMembers.length === 1 ? 'standalone' : isLeader ? 'leader' : 'member',
        pid: process.pid,
      };
    } catch (error) {
      return {
        mode: 'degraded',
        sharedPort: this.port,
        role: 'unknown',
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  passiveLockStatus(): ReturnType<typeof passiveLockStatus> {
    return passiveLockStatus(this.config);
  }

  get appsUrl(): string {
    return `${this.resolvedPublicBaseUrl()}/mcp/${this.config.connectorKey}`;
  }

  get openApiUrl(): string {
    return `${this.resolvedPublicBaseUrl()}/openapi.json`;
  }

  activeMcpSessions(): number {
    return this.mcp.activeSessions();
  }

  log(message: string, level: RuntimeLog['level'] = 'info'): void {
    const entry = { at: new Date().toISOString(), level, message };
    this.logs.push(entry);
    try { appendWorkspaceLog(this.config.stateDir, entry); } catch { /* logging must never crash the runtime */ }
    if (this.logs.length > 500) this.logs.shift();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.internalServer.once('error', reject);
      this.internalServer.listen(0, '127.0.0.1', () => {
        this.internalServer.off('error', reject);
        this.internalAddress = this.internalServer.address() as AddressInfo;
        resolve();
      });
    });
    if (this.config.port === 0) {
      await this.becomeStandaloneLeader(0);
      this.publishWorkspaceRuntime();
      this.startConfiguredPassiveLock();
      return;
    }
    this.cluster = new PortClusterRegistry(path.dirname(this.config.settingsPath), this.config.host, this.config.port);
    this.clusterMember = this.cluster.register({
      pid: process.pid,
      appVersion: CURRENT_VERSION,
      protocolVersion: CLUSTER_PROTOCOL_VERSION,
      workspaceId: workspaceId(this.config.workspaceDir),
      workspaceDir: this.config.workspaceDir,
      internalPort: this.internalAddress!.port,
      connectorKey: this.config.connectorKey,
      actionsTokenHash: tokenHash(this.config.actionsToken),
      secret: randomBytes(24).toString('hex'),
    });
    this.clusterRouter = new ClusterExtensionRouter(this.cluster, this.cluster.memberId);
    this.clusterMcp = new LiteMcpTransport(this.clusterRouter);
    await this.tryBecomeLeader();
    const state = this.cluster.read();
    const leader = state.members.find((item) => item.id === state.leaderId);
    if (!this.publicServer?.listening && !leader) {
      try { this.cluster.unregister(); } catch { /* best effort */ }
      await new Promise<void>((resolve) => this.internalServer.close(() => resolve()));
      const cause = Object.assign(new Error(`listen EADDRINUSE: address already in use ${this.config.host}:${this.config.port}`), { code: 'EADDRINUSE', syscall: 'listen', address: this.config.host, port: this.config.port });
      const wrapped = new Error(`Failed to start LocalTerminal Lite on ${this.config.host}:${this.config.port} [EADDRINUSE]: ${cause.message}`, { cause });
      Object.assign(wrapped, { code: 'EADDRINUSE', host: this.config.host, port: this.config.port, syscall: 'listen' });
      throw wrapped;
    }
    this.heartbeatTimer = setInterval(() => {
      try { this.cluster?.heartbeat(); }
      catch (error) { this.log(`Cluster heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
    }, 1500);
    this.electionTimer = setInterval(() => {
      if (!this.publicServer?.listening) {
        void this.tryBecomeLeader().catch((error) => this.log(`Cluster election failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
      }
    }, 1800);
    this.log(this.publicServer?.listening
      ? `Lite cluster leader listening on ${this.config.host}:${this.config.port}`
      : `Lite workspace joined shared port ${this.config.host}:${this.config.port} via PID ${leader?.pid}`);
    this.publishWorkspaceRuntime();
    this.startConfiguredPassiveLock();
  }

  private publishWorkspaceRuntime(): void {
    try { this.workspaceCatalog.publish(this.config, this.port); }
    catch { /* registry is best effort */ }
  }

  private releaseWorkspaceRuntime(): void {
    try { this.workspaceCatalog.release(this.config.workspaceDir); }
    catch { /* registry is best effort */ }
  }

  private startConfiguredPassiveLock(): void {
    if (!this.config.passiveLockEnabled || process.platform !== 'darwin') return;
    try {
      if (!passiveLockStatus(this.config).running) startPassiveLockService(this.config, 'standby');
    } catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); }
  }

  private async becomeStandaloneLeader(port: number): Promise<void> {
    const server = http.createServer(this.app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.config.host, () => { server.off('error', reject); resolve(); });
    });
    this.publicServer = server;
    this.address = server.address() as AddressInfo;
    this.log(`Lite server listening on ${this.config.host}:${this.address.port}`);
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.publicServer?.listening || !this.cluster || !this.clusterRouter || !this.clusterMcp) return;
    const gateway = this.createClusterGateway();
    const server = http.createServer(gateway);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.port, this.config.host, () => { server.off('error', reject); resolve(); });
      });
      this.publicServer = server;
      this.address = server.address() as AddressInfo;
      this.cluster.setLeader();
      this.log(`This workspace became leader for ${this.config.host}:${this.config.port}`);
    } catch (error) {
      server.close();
      const detail = error as NodeJS.ErrnoException;
      if (detail.code !== 'EADDRINUSE') throw error;
    }
  }

  private createClusterGateway(): Express {
    const gateway = express();
    gateway.disable('x-powered-by');
    gateway.use(express.json({ limit: '256kb' }));
    gateway.get('/health', (_req, res) => {
      const state = this.cluster!.read();
      res.json({ ok: true, product: 'localterminal-lite', version: CURRENT_VERSION, protocolVersion: CLUSTER_PROTOCOL_VERSION, clustered: true, leaderPid: process.pid, workspaces: state.members.map((item) => ({ id: item.workspaceId, workspaceDir: item.workspaceDir, pid: item.pid, version: item.appVersion, protocolVersion: item.protocolVersion })) });
    });
    gateway.get('/openapi.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    gateway.get('/openapi-3.1.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    gateway.all('/mcp/:connectorKey', async (req, res) => {
      if (!safeEqual(String(req.params.connectorKey || ''), this.config.connectorKey)) { res.status(404).json({ error: 'Not found.' }); return; }
      try { await this.clusterMcp!.handle(req, res); }
      catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); if (!res.headersSent) res.status(500).json({ error: 'MCP transport failure.' }); }
    });
    gateway.post('/actions/extensions/discover', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.discover(req.body, { transport: 'actions' })));
    gateway.post('/actions/extensions/register', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.register(req.body, { transport: 'actions' })));
    gateway.post('/actions/extensions/call', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.call(req.body, { transport: 'actions' })));
    gateway.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    return gateway;
  }

  async close(): Promise<void> {
    disarmAllSessionResources(this.config);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.electionTimer) clearInterval(this.electionTimer);

    // Stop accepting public traffic before removing this member from the shared
    // registry. Doing this in the opposite order leaves a live gateway with an
    // empty member list during shutdown, which surfaces as a false
    // WORKSPACE_UNAVAILABLE response even though another member can take over.
    if (this.publicServer?.listening) await new Promise<void>((resolve) => this.publicServer!.close(() => resolve()));
    try { this.cluster?.unregister(); } catch { /* best effort */ }

    await this.mcp.close();
    if (this.clusterMcp) await this.clusterMcp.close();
    if (this.internalServer.listening) await new Promise<void>((resolve) => this.internalServer.close(() => resolve()));
    this.releaseWorkspaceRuntime();

    // The passive-lock helper is global to the LocalTerminal installation, not
    // owned by an individual workspace runtime. Stop it only after this lease
    // is released and no other live LocalTerminal process remains.
    if (process.platform === 'darwin' && activeWorkspaceRuntimePids(path.dirname(this.config.settingsPath), process.pid).length === 0) {
      try { commandPassiveLock(this.config, 'stop'); }
      catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); }
    }
  }

  private configureRoutes(): void {
    this.app.get('/health', (_req, res) => res.json({ ok: true, product: 'localterminal-lite', version: '1.0.1', toolsExposed: 3, sessions: this.store.listSessions().length, activeMcpSessions: this.activeMcpSessions() }));
    this.app.get('/openapi.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    this.app.get('/openapi-3.1.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    this.app.all('/mcp/:connectorKey', async (req, res) => {
      if (!safeEqual(String(req.params.connectorKey || ''), this.config.connectorKey)) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }
      try {
        await this.mcp.handle(req, res);
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error), 'error');
        if (!res.headersSent) res.status(500).json({ error: 'MCP transport failure.' });
      }
    });
    this.app.post('/actions/extensions/discover', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.discover(req.body, { transport: 'actions' })));
    this.app.post('/actions/extensions/register', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.register(req.body, { transport: 'actions' })));
    this.app.post('/actions/extensions/call', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.call(req.body, { transport: 'actions' })));
    this.app.post('/cluster/owns', async (req, res) => {
      if (!this.clusterMember || req.header('x-localterminal-cluster-secret') !== this.clusterMember.secret) { res.status(404).json({ error: 'Not found.' }); return; }
      const clientSessionKey = typeof req.body?.clientSessionKey === 'string' ? req.body.clientSessionKey : '';
      res.json({ owned: Boolean(clientSessionKey && this.store.snapshot().appBindings.some((item) => item.clientSessionKey === clientSessionKey)) });
    });
    this.app.post('/cluster/rpc/:method', async (req, res) => {
      if (!this.clusterMember || req.header('x-localterminal-cluster-secret') !== this.clusterMember.secret) { res.status(404).json({ error: 'Not found.' }); return; }
      const body = req.body as { input?: Record<string, unknown>; context?: Record<string, unknown> };
      const input = body.input || {};
      const context = (body.context || { transport: 'actions' }) as never;
      const method = String(req.params.method || '');
      if (method === 'discover') { res.json(await this.extensions.discover(input, context)); return; }
      if (method === 'register') { res.json(await this.extensions.register(input, context)); return; }
      if (method === 'call') { res.json(await this.extensions.call(input, context)); return; }
      res.status(404).json({ error: 'Not found.' });
    });
    this.app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    this.app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
      this.log(error instanceof Error ? error.message : String(error), 'error');
      res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Malformed request.', retryable: false } });
    });
  }

  private readonly requireActionsAuth = (req: Request, res: Response, next: () => void): void => {
    const header = req.header('authorization') || '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!candidate || !safeEqual(candidate, this.config.actionsToken)) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer credential required.', retryable: false } });
      return;
    }
    next();
  };

  private sendAction(res: Response, response: ToolResponse): void {
    const status = response.ok ? 200 : response.error?.code === 'NOT_FOUND' ? 404 : response.error?.code === 'INVALID_IDENTITY' || response.error?.code === 'IDENTITY_REQUIRED' ? 401 : 400;
    res.status(status).json(response);
  }

  private resolvedPublicBaseUrl(): string {
    if (this.config.port !== 0) return this.config.publicBaseUrl;
    return this.config.publicBaseUrl.replace(/:\d+$/, `:${this.port}`);
  }
}
