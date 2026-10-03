import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Fact } from '../types/expense.js';
import {
  supabaseConfigured,
  selectRows,
  insertRow,
  updateRow,
} from './supabase.js';

const TABLE = 'facts';

let memoryPath: string;

export function initFactStore(path: string) {
  memoryPath = path;
  if (!supabaseConfigured()) ensureFile();
}

async function ensureFile() {
  if (!memoryPath) return;
  const dir = dirname(memoryPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(memoryPath)) {
    await writeFile(memoryPath, '[]', 'utf-8');
  }
}

async function loadFacts(): Promise<Fact[]> {
  await ensureFile();
  const raw = await readFile(memoryPath, 'utf-8');
  return JSON.parse(raw) as Fact[];
}

async function saveFacts(facts: Fact[]) {
  await writeFile(memoryPath, JSON.stringify(facts, null, 2), 'utf-8');
}

function lit(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function getFact(key: string): Promise<Fact | undefined> {
  if (supabaseConfigured()) {
    const rows = await selectRows<Fact>(TABLE, `?key=eq.${lit(key)}&limit=1`);
    return rows[0];
  }
  const facts = await loadFacts();
  return facts.find(f => f.key === key);
}

export async function setFact(
  key: string,
  value: unknown,
  source: Fact['source'] = 'user',
  notes = ''
): Promise<Fact> {
  const existing = await getFact(key);
  const fact: Fact = {
    id: existing?.id ?? randomUUID(),
    key,
    value,
    source,
    notes,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };

  if (supabaseConfigured()) {
    if (existing) {
      const rows = await updateRow<Fact>(
        TABLE,
        `?key=eq.${lit(key)}`,
        { value, source, notes }
      );
      return rows[0] ?? fact;
    }
    const [row] = await insertRow<Fact>(TABLE, fact);
    return row ?? fact;
  }

  const facts = await loadFacts();
  const idx = facts.findIndex(f => f.key === key);
  if (idx >= 0) {
    facts[idx] = fact;
  } else {
    facts.push(fact);
  }
  await saveFacts(facts);
  return fact;
}

export async function getAllFacts(): Promise<Fact[]> {
  if (supabaseConfigured()) {
    return selectRows<Fact>(TABLE, '?order=created_at.desc');
  }
  return loadFacts();
}