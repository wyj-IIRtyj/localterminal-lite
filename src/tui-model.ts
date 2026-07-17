import type { LiteMessage, LiteSession } from './types.js';

export type LogicalSessionGroup = { id: string; title: string; sessions: LiteSession[]; children: LiteSession[]; current: LiteSession };
export type ConversationGroup = { id: string; sessionIds: [string, string]; messages: LiteMessage[]; lastMessage: LiteMessage };

export function logicalSessionGroups(sessions: LiteSession[]): LogicalSessionGroup[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => !session.parentSessionId);
  const originId = (session: LiteSession): string => {
    const seen = new Set<string>(); let current = session;
    while (current.continuesSessionId && !seen.has(current.id)) {
      seen.add(current.id); const predecessor = byId.get(current.continuesSessionId);
      if (!predecessor || predecessor.parentSessionId) break;
      current = predecessor;
    }
    return current.id;
  };
  const grouped = new Map<string, LiteSession[]>();
  for (const session of roots) { const origin = originId(session); grouped.set(origin, [...(grouped.get(origin) || []), session]); }
  return [...grouped.entries()].map(([id, chain]) => {
    const ordered = chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); const memberIds = new Set(ordered.map((item) => item.id));
    const children = sessions.filter((session) => session.parentSessionId && memberIds.has(session.parentSessionId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { id, title: ordered[0]?.name || id, sessions: ordered, children, current: ordered.at(-1)! };
  }).sort((a, b) => b.current.updatedAt.localeCompare(a.current.updatedAt));
}

export function conversationGroups(messages: LiteMessage[]): ConversationGroup[] {
  const groups = new Map<string, LiteMessage[]>();
  for (const message of messages) {
    const pair = [message.from, message.to].sort() as [string, string]; const id = pair.join('::');
    groups.set(id, [...(groups.get(id) || []), message]);
  }
  return [...groups.entries()].map(([id, items]) => {
    const ordered = items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { id, sessionIds: id.split('::') as [string, string], messages: ordered, lastMessage: ordered.at(-1)! };
  }).sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
}

export function selectedViewport<T>(items: T[], selected: number, height: number): { selected: number; start: number; visible: T[] } {
  const index = Math.max(0, Math.min(Math.max(0, items.length - 1), selected)); const size = Math.max(1, height);
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), Math.max(0, items.length - size)));
  return { selected: index, start, visible: items.slice(start, start + size) };
}
