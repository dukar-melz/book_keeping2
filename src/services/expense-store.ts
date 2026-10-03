import { writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Expense, CreateExpenseInput, ExpenseFilter } from '../types/expense.js';
import {
  supabaseConfigured,
  selectRows,
  insertRow,
  updateRow,
  deleteRows,
} from './supabase.js';

const TABLE = 'expenses';

let memoryPath: string;
let diskAvailable = true;

export function initExpenseStore(path: string) {
  memoryPath = path;
  diskAvailable = supabaseConfigured() ? false : ensureDisk();
}

/** Create the JSON store up front. Returns false on a read-only filesystem. */
function ensureDisk(): boolean {
  if (!memoryPath) return false;
  try {
    const dir = dirname(memoryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(memoryPath)) {
      writeFileSync(memoryPath, '[]', 'utf-8');
    }
    return true;
  } catch {
    return false;
  }
}

function getDefaults(): Omit<Expense, 'id' | 'vendor' | 'amount' | 'created_at' | 'updated_at'> {
  return {
    date: new Date().toISOString().slice(0, 10),
    description: '',
    category: 'Other',
    currency: 'USD',
    amount_usd: 0,
    exchange_rate: null,
    payment_method: 'card',
    receipt: { filename: null, path: null, extracted: false },
    line_items: [],
    tags: [],
    notes: '',
  };
}

async function loadExpenses(): Promise<Expense[]> {
  if (!diskAvailable) {
    throw new Error(
      'No writable storage. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this deployment.'
    );
  }
  const raw = await readFile(memoryPath, 'utf-8');
  return JSON.parse(raw) as Expense[];
}

async function saveExpenses(expenses: Expense[]) {
  await writeFile(memoryPath, JSON.stringify(expenses, null, 2), 'utf-8');
}

/** Percent-encode a value for a PostgREST filter.
 *
 * This used to wrap values in double quotes, but PostgREST does not strip them:
 * uuid filters failed with 22P02 ("invalid input syntax for type uuid") and text
 * filters silently matched nothing because it compared against a literal
 * `"software"`. Encoding also stops a vendor name containing `&` from injecting
 * extra filter parameters. */
function val(value: string): string {
  return encodeURIComponent(value);
}

function buildQuery(filter?: ExpenseFilter): string {
  const parts: string[] = [];
  if (filter?.category) parts.push(`category=eq.${val(filter.category)}`);
  if (filter?.vendor) parts.push(`vendor=ilike.${val(`%${filter.vendor}%`)}`);
  if (filter?.start_date) parts.push(`date=gte.${val(filter.start_date)}`);
  if (filter?.end_date) parts.push(`date=lte.${val(filter.end_date)}`);
  if (filter?.currency) parts.push(`currency=eq.${val(filter.currency)}`);
  if (filter?.tags && filter.tags.length > 0) {
    // Braces and inner quotes are genuine array syntax, so encode the whole
    // list in one go and let PostgREST decode before it parses the array.
    const arr = `{${filter.tags
      .map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',')}}`;
    parts.push(`tags=ov.${encodeURIComponent(arr)}`);
  }
  parts.push('order=date.desc,created_at.desc');
  return `?${parts.join('&')}`;
}

function matches(expense: Expense, filter?: ExpenseFilter): boolean {
  if (!filter) return true;
  if (filter.category && expense.category !== filter.category) return false;
  if (filter.vendor && !expense.vendor.toLowerCase().includes(filter.vendor.toLowerCase())) return false;
  if (filter.start_date && expense.date < filter.start_date) return false;
  if (filter.end_date && expense.date > filter.end_date) return false;
  if (filter.currency && expense.currency !== filter.currency) return false;
  if (filter.tags && filter.tags.length > 0 && !filter.tags.some(t => expense.tags.includes(t))) return false;
  return true;
}

export async function getAll(filter?: ExpenseFilter): Promise<Expense[]> {
  if (supabaseConfigured()) {
    return selectRows<Expense>(TABLE, buildQuery(filter));
  }
  const expenses = await loadExpenses();
  if (!filter) return expenses;
  return expenses.filter(e => matches(e, filter));
}

export async function getById(id: string): Promise<Expense | undefined> {
  if (supabaseConfigured()) {
    const rows = await selectRows<Expense>(TABLE, `?id=eq.${val(id)}&limit=1`);
    return rows[0];
  }
  const expenses = await loadExpenses();
  return expenses.find(e => e.id === id);
}

export async function create(input: CreateExpenseInput): Promise<Expense> {
  const defaults = getDefaults();
  const now = new Date().toISOString();
  const expense: Expense = {
    ...defaults,
    id: randomUUID(),
    date: input.date || defaults.date,
    vendor: input.vendor,
    description: input.description || '',
    category: input.category || 'Other',
    currency: input.currency || 'USD',
    amount: input.amount,
    amount_usd: input.amount_usd ?? input.amount,
    exchange_rate: input.exchange_rate !== undefined ? input.exchange_rate : null,
    payment_method: input.payment_method || 'card',
    receipt: input.receipt ?? defaults.receipt,
    line_items: input.line_items || [],
    tags: input.tags || [],
    notes: input.notes || '',
    created_at: now,
    updated_at: now,
  };

  if (supabaseConfigured()) {
    const [row] = await insertRow<Expense>(TABLE, expense);
    return row ?? expense;
  }

  const expenses = await loadExpenses();
  expenses.push(expense);
  await saveExpenses(expenses);
  return expense;
}

export async function update(id: string, updates: Partial<Expense>): Promise<Expense | undefined> {
  const patch = { ...updates, updated_at: new Date().toISOString() };

  if (supabaseConfigured()) {
    const rows = await updateRow<Expense>(TABLE, `?id=eq.${val(id)}`, patch);
    return rows[0];
  }

  const expenses = await loadExpenses();
  const idx = expenses.findIndex(e => e.id === id);
  if (idx === -1) return undefined;
  expenses[idx] = { ...expenses[idx]!, ...patch };
  await saveExpenses(expenses);
  return expenses[idx];
}

export async function remove(id: string): Promise<boolean> {
  if (supabaseConfigured()) {
    const existing = await getById(id);
    if (!existing) return false;
    await deleteRows(TABLE, `?id=eq.${val(id)}`);
    return true;
  }

  const expenses = await loadExpenses();
  const idx = expenses.findIndex(e => e.id === id);
  if (idx === -1) return false;
  expenses.splice(idx, 1);
  await saveExpenses(expenses);
  return true;
}