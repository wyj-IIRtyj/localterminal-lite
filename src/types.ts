export type JsonObject = Record<string, unknown>;

export type SessionStatus = 'active' | 'idle' | 'blocked' | 'completed';

export type LiteSession = {
  id: string;
  name: string;
  role: string;
  status: SessionStatus;
  clientSessionKey?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type LiteMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt?: string;
};

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

export type ExtensionAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
};

export type BuiltinExtensionHandler = {
  kind: 'builtin';
  target: string;
  defaults?: JsonObject;
};

export type CommandExtensionHandler = {
  kind: 'command';
  executable: string;
  args?: string[];
  cwd?: string;
  timeoutSec?: number;
};

export type CustomExtensionSpec = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ExtensionAnnotations;
  handler: BuiltinExtensionHandler | CommandExtensionHandler;
};

export type StoredState = {
  schemaVersion: 1;
  revision: number;
  sessions: LiteSession[];
  messages: LiteMessage[];
  extensions: CustomExtensionSpec[];
};

export type LiteConfigFile = {
  schemaVersion: 1;
  connectorKey: string;
  actionsToken: string;
  publicBaseUrl?: string;
};

export type LiteConfig = {
  workspaceDir: string;
  stateDir: string;
  host: string;
  port: number;
  connectorKey: string;
  actionsToken: string;
  publicBaseUrl: string;
  maxOutputChars: number;
  commandTimeoutSec: number;
};

export type InvocationContext = {
  sessionId?: string;
  clientSessionKey?: string;
  transport: 'apps' | 'actions' | 'tui' | 'test';
};

export type ToolResponse = {
  ok: boolean;
  data?: JsonObject;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ExtensionAnnotations;
  invoke: (input: JsonObject, context: InvocationContext) => Promise<JsonObject>;
};
