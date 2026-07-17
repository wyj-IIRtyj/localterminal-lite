import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CustomExtensionSpec, LiteMessage, LiteSession, SessionStatus, StoredState } from './types.js';

const EMPTY_STATE: StoredState = { schemaVersion: 1, revision: 0, sessions: [], messages: [], extensions: [] };

export class LiteStore {
  private state: StoredState;
  private readonly statePath: string;

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, 'state.json');
    this.state = this.load();
  }

  snapshot(): StoredState {
    return structuredClone(this.state);
  }

  listSessions(): LiteSession[] {
    return structuredClone(this.state.sessions);
  }

  registerSession(args: { name: string; role?: string; clientSessionKey?: string }): LiteSession {
    const name = args.name.trim();
    if (!name || name.length > 80) throw new Error('Session name must contain 1-80 characters.');
    const duplicate = this.state.sessions.find((session) => session.name === name);
    if (duplicate) {
      duplicate.clientSessionKey = args.clientSessionKey ?? duplicate.clientSessionKey;
      duplicate.updatedAt = new Date().toISOString();
      this.save();
      return structuredClone(duplicate);
    }
    const now = new Date().toISOString();
    const session: LiteSession = {
      id: `ses_${randomUUID()}`,
      name,
      role: (args.role || 'developer').slice(0, 80),
      status: 'active',
      clientSessionKey: args.clientSessionKey,
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions.push(session);
    this.save();
    return structuredClone(session);
  }

  resolveSession(args: { sessionId?: string; clientSessionKey?: string; autoName?: string }): LiteSession {
    let session = args.sessionId ? this.state.sessions.find((item) => item.id === args.sessionId || item.name === args.sessionId) : undefined;
    if (!session && args.clientSessionKey) session = this.state.sessions.find((item) => item.clientSessionKey === args.clientSessionKey);
    if (!session) session = this.registerSession({ name: args.autoName || `session-${this.state.sessions.length + 1}`, clientSessionKey: args.clientSessionKey });
    session.updatedAt = new Date().toISOString();
    if (args.clientSessionKey) session.clientSessionKey = args.clientSessionKey;
    this.save();
    return structuredClone(session);
  }

  updateSession(id: string, patch: { status?: SessionStatus; note?: string; role?: string }): LiteSession {
    const session = this.state.sessions.find((item) => item.id === id || item.name === id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (patch.status) session.status = patch.status;
    if (patch.note !== undefined) session.note = patch.note.slice(0, 500);
    if (patch.role !== undefined) session.role = patch.role.slice(0, 80);
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  unregisterSession(id: string): void {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => item.id !== id && item.name !== id);
    if (before === this.state.sessions.length) throw new Error(`Session not found: ${id}`);
    this.save();
  }

  sendMessage(from: string, to: string, body: string): LiteMessage {
    const sender = this.state.sessions.find((item) => item.id === from || item.name === from);
    const recipient = this.state.sessions.find((item) => item.id === to || item.name === to);
    if (!sender) throw new Error(`Sender session not found: ${from}`);
    if (!recipient) throw new Error(`Recipient session not found: ${to}`);
    const cleanBody = body.trim();
    if (!cleanBody || cleanBody.length > 20_000) throw new Error('Message must contain 1-20000 characters.');
    const message: LiteMessage = {
      id: `msg_${randomUUID()}`,
      from: sender.id,
      to: recipient.id,
      body: cleanBody,
      createdAt: new Date().toISOString(),
    };
    this.state.messages.push(message);
    if (this.state.messages.length > 5_000) this.state.messages.splice(0, this.state.messages.length - 5_000);
    this.save();
    return structuredClone(message);
  }

  inbox(sessionId: string, markRead = false): LiteMessage[] {
    const session = this.state.sessions.find((item) => item.id === sessionId || item.name === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const messages = this.state.messages.filter((message) => message.to === session.id);
    if (markRead) {
      const now = new Date().toISOString();
      for (const message of messages) message.readAt ||= now;
      this.save();
    }
    return structuredClone(messages);
  }

  listMessages(limit = 100): LiteMessage[] {
    return structuredClone(this.state.messages.slice(-Math.max(1, Math.min(1000, limit))));
  }

  upsertExtension(spec: CustomExtensionSpec): CustomExtensionSpec {
    const index = this.state.extensions.findIndex((item) => item.name === spec.name);
    if (index >= 0) this.state.extensions[index] = structuredClone(spec);
    else this.state.extensions.push(structuredClone(spec));
    this.save();
    return structuredClone(spec);
  }

  removeExtension(name: string): void {
    const before = this.state.extensions.length;
    this.state.extensions = this.state.extensions.filter((item) => item.name !== name);
    if (before === this.state.extensions.length) throw new Error(`Custom extension not found: ${name}`);
    this.save();
  }

  private load(): StoredState {
    if (!existsSync(this.statePath)) return structuredClone(EMPTY_STATE);
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as StoredState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.extensions)) {
      throw new Error(`Invalid Lite state: ${this.statePath}`);
    }
    return parsed;
  }

  private save(): void {
    this.state.revision += 1;
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
}
