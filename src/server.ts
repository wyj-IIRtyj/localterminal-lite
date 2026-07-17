import express, { type Express, type Request, type Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildOpenApi } from './openapi.js';
import { createBuiltinTools } from './core-tools.js';
import { ExtensionService } from './extensions.js';
import { LiteMcpTransport } from './mcp.js';
import { safeEqual } from './security.js';
import { LiteStore } from './store.js';
import type { LiteConfig, ToolResponse } from './types.js';

export type RuntimeLog = { at: string; level: 'info' | 'error'; message: string };

export class LiteRuntime {
  readonly store: LiteStore;
  readonly extensions: ExtensionService;
  readonly app: Express;
  readonly logs: RuntimeLog[] = [];
  private readonly mcp: LiteMcpTransport;
  private readonly server: http.Server;
  private address?: AddressInfo;

  constructor(readonly config: LiteConfig) {
    this.store = new LiteStore(config.stateDir);
    const builtins = createBuiltinTools(config, this.store);
    this.extensions = new ExtensionService(config, this.store, builtins);
    this.mcp = new LiteMcpTransport(this.extensions);
    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '256kb' }));
    this.server = http.createServer(this.app);
    this.configureRoutes();
  }

  get port(): number {
    return this.address?.port ?? this.config.port;
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
    this.logs.push({ at: new Date().toISOString(), level, message });
    if (this.logs.length > 500) this.logs.shift();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        this.address = this.server.address() as AddressInfo;
        this.log(`Lite server listening on ${this.config.host}:${this.address.port}`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await this.mcp.close();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private configureRoutes(): void {
    this.app.get('/health', (_req, res) => res.json({ ok: true, product: 'localterminal-lite', version: '0.1.0', toolsExposed: 3, sessions: this.store.listSessions().length, activeMcpSessions: this.activeMcpSessions() }));
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
    this.app.post('/actions/extensions/discover', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.discover(req.body)));
    this.app.post('/actions/extensions/register', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.register(req.body)));
    this.app.post('/actions/extensions/call', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.call(req.body, { transport: 'actions', sessionId: typeof req.body.sessionId === 'string' ? req.body.sessionId : req.header('x-session-id') || undefined })));
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
    const status = response.ok ? 200 : response.error?.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json(response);
  }

  private resolvedPublicBaseUrl(): string {
    if (this.config.port !== 0) return this.config.publicBaseUrl;
    return this.config.publicBaseUrl.replace(/:\d+$/, `:${this.port}`);
  }
}
