import { randomUUID } from 'node:crypto';
import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import type { MemoryEntry } from '@agent-desktop/client';

interface PersistedMemories { readonly entries: readonly MemoryEntry[] }

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('记忆内容不能为空。');
  return value.trim();
}

function readEntries(path: string): MemoryEntry[] {
  const raw = readDesktopDocument(path, 'memories');
  if (raw === null) return [];
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as PersistedMemories).entries)) throw new Error('本地记忆结构无效。');
  return [...(raw as PersistedMemories).entries];
}

export function loadMemories(path: string): readonly MemoryEntry[] { return readEntries(path); }

export function saveMemory(path: string, content: string, source: MemoryEntry['source']): MemoryEntry {
  const now = new Date().toISOString();
  const entry: MemoryEntry = { id: randomUUID(), content: text(content), createdAt: now, updatedAt: now, source };
  const entries = [...readEntries(path), entry];
  writeDesktopDocuments(path, [{ name: 'memories', value: { entries } }]);
  return entry;
}

export function deleteMemories(path: string): void {
  writeDesktopDocuments(path, [{ name: 'memories', value: { entries: [] } }]);
}
