import { getAll, create } from './expense-store.js';
import { complete, extractJson, llmConfigured, LlmError } from './llm.js';
import { convertToUsd } from './currency.js';
import type { CreateExpenseInput, Expense, ExpenseFilter } from '../types/expense.js';

/** The UI's category select defines this list, so the model is held to it.
 * Free models invent categories freely, and a stray one breaks both the tag
 * colouring and the category filter. */
const CATEGORIES = [
  'Office',
  'Meals & Entertainment',
  'Transportation',
  'Software',
  'Rent',
  'Supplies',
  'Other',
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'MXN', 'BRL'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a relative period in code — a model asked to work out "last month"
 * gets the boundaries wrong often enough to be worth not asking. */
function resolvePeriod(period: unknown): { start?: string; end?: string; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case 'today':
      return { start: iso(now), end: iso(now), label: 'today' };
    case 'yesterday': {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 1);
      return { start: iso(d), end: iso(d), label: 'yesterday' };
    }
    case 'this_week': {
      const start = new Date(now);
      const dow = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - dow);
      return { start: iso(start), end: iso(now), label: 'this week' };
    }
    case 'last_month': {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      return { start: iso(start), end: iso(end), label: 'last month' };
    }
    case 'this_year':
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: `in ${y}` };
    case 'last_30_days':
      return {
        start: iso(new Date(now.getTime() - 30 * 864e5)),
        end: iso(now),
        label: 'in the last 30 days',
      };
    default:
      return { label: 'in total' };
  }
}

const PLANNER_SYSTEM = `You route a bookkeeping assistant's messages. Reply with ONLY a JSON object, no prose, no code fences.

Schema:
{
  "intent": "log_expense" | "question" | "unknown",
  "expense": {
    "vendor": string,
    "amount": number,
    "currency": string,
    "category": string,
    "description": string,
    "date": "YYYY-MM-DD"
  },
  "question": {
    "kind": "total" | "by_category" | "by_vendor" | "largest" | "count" | "recent",
    "period": "today" | "yesterday" | "this_week" | "last_month" | "this_month" | "this_year" | "last_30_days" | "all",
    "vendor": string | null,
    "category": string | null
  }
}

Rules:
- intent "log_expense" when the message reports money spent, paid, bought or received. vendor and amount are required.
- intent "question" when the message asks about spending, totals, categories, counts or what was purchased.
- intent "unknown" for greetings or anything you cannot place.
- category MUST be exactly one of: ${CATEGORIES.join(', ')}.
- currency MUST be a 3-letter code, default "USD".
- date defaults to today's date and must be within the last 2 years.
- Use null for any question field that is not stated.`;

interface Planned {
  intent: 'log_expense' | 'question' | 'unknown';
  expense?: {
    vendor?: unknown;
    amount?: unknown;
    currency?: unknown;
    category?: unknown;
    description?: unknown;
    date?: unknown;
  };
  question?: {
    kind?: unknown;
    period?: unknown;
    vendor?: unknown;
    category?: unknown;
  };
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.-]/g, '');
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function plan(message: string): Promise<Planned> {
  const raw = await complete(
    PLANNER_SYSTEM,
    `Message: ${message}\n\nToday is ${today()}. Return the JSON object.`,
    300
  );
  return extractJson(raw) as Planned;
}

function normaliseExpense(p: Planned['expense']) {
  const vendor = str(p?.vendor);
  const amount = num(p?.amount);
  if (!vendor || amount === null || amount <= 0) return null;

  const currencyRaw = str(p?.currency, 'USD').toUpperCase();
  const currency = CURRENCIES.includes(currencyRaw) ? currencyRaw : 'USD';

  const categoryRaw = str(p?.category, 'Other');
  const category = CATEGORIES.includes(categoryRaw) ? categoryRaw : 'Other';

  const dateRaw = str(p?.date);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : today();

  return {
    vendor,
    amount: Math.round(amount * 100) / 100,
    currency,
    category,
    description: str(p?.description),
    date,
  };
}

/** Last-resort parser so a flaky model still logs the obvious cases.
 *
 * Anchors on the trigger word and the "at/from/on" preposition rather than
 * assuming they are adjacent, because "bought $30 of printer ink at Staples"
 * has three words between the amount and the vendor and the naive pattern
 * silently dropped it. */
export function parseExpensePhrase(message: string) {
  const trigger = message.match(
    /\b(spent|paid|bought|purchased|cost(?:\s+me)?|charged)\b/i
  );
  if (!trigger) return null;
  const after = message.slice(trigger.index! + trigger[0].length);

  // Amount in any of the shapes people actually type: "$50", "50",
  // "50 EUR", "EUR 50", "$1,250.75".
  const amountMatch = after.match(
    /(?<![A-Za-z0-9])(?:(?<pre>[A-Z]{3})\s*)?\$?\s*(?<num>\d[\d,]*(?:\.\d{1,2})?)\s*(?<post>[A-Z]{3})?(?![A-Za-z0-9])/
  );
  if (!amountMatch || amountMatch.index === undefined || !amountMatch.groups) return null;
  const amount = parseFloat(amountMatch.groups.num!.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = (amountMatch.groups.pre || amountMatch.groups.post || 'USD').toUpperCase();

  // Vendor follows the LAST "at/from/on" after the amount: in
  // "spent USD 80 on hosting at Vercel" the first anchor introduces the
  // description and the second the vendor.
  const tail = after.slice(amountMatch.index + amountMatch[0].length);
  const anchors = [...tail.matchAll(/\s(?:at|from|on)\s/gi)];
  const anchor = anchors.pop();
  if (!anchor || anchor.index === undefined) return null;

  // "Starbucks for coffee" is a vendor plus a reason, not a vendor.
  let vendor = tail.slice(anchor.index + anchor[0].length).trim();
  const parts: string[] = [];
  const trailing = vendor.match(/\s+(?:for|to)\s+(.+)$/i);
  if (trailing && trailing.index !== undefined) {
    parts.push(trailing[1]!.trim());
    vendor = vendor.slice(0, trailing.index).trim();
  }
  if (!vendor) return null;

  const between = tail
    .slice(0, anchor.index)
    .replace(/^\s*(?:of|for|on|to)\s+/i, '')
    .trim();
  if (between) parts.unshift(between);

  return {
    vendor,
    amount: Math.round(amount * 100) / 100,
    currency,
    category: 'Other' as string,
    description: parts.join(' for ').trim(),
    date: today(),
    inferred: true,
  };
}

function summarise(expenses: Expense[], label: string): string {
  const total = expenses.reduce((s, e) => s + e.amount_usd, 0);
  const lines: string[] = [
    `Period: ${label}`,
    `Entries: ${expenses.length}`,
    `Total: ${total.toFixed(2)} USD`,
    '',
  ];
  if (!expenses.length) return `${lines.join('\n')}No expenses recorded.`;

  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount_usd);
  }
  lines.push('By category (USD):');
  for (const [k, v] of [...byCategory].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v.toFixed(2)}`);
  }

  const byVendor = new Map<string, number>();
  for (const e of expenses) {
    byVendor.set(e.vendor, (byVendor.get(e.vendor) ?? 0) + e.amount_usd);
  }
  lines.push('', 'By vendor (USD):');
  for (const [k, v] of [...byVendor].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    lines.push(`- ${k}: ${v.toFixed(2)}`);
  }

  lines.push('', 'Entries:');
  for (const e of expenses.slice(0, 40)) {
    lines.push(
      `- ${e.date} | ${e.vendor} | ${e.description || e.category} | ${e.amount.toFixed(2)} ${e.currency} (${e.amount_usd.toFixed(2)} USD)`
    );
  }
  if (expenses.length > 40) lines.push(`- ...and ${expenses.length - 40} more`);
  return lines.join('\n');
}

/** Keyword rules, used when the model is unavailable. Deterministic, free and
 * instant — a rate-limited model must never mean every expense lands in
 * "Other", which would quietly wreck the category reports. */
const RULES: [RegExp, string][] = [
  [/\b(software|saas|subscription|hosting|domain|licen[cs]e|api|aws|azure|vercel|github|slack|notion|adobe|office 365|cloud)\b/i, 'Software'],
  [/\b(rent|lease|landlord|mortgage)\b/i, 'Rent'],
  [/\b(uber|lyft|taxi|bus|train|flight|airline|petrol|gas|fuel|parking|toll|metro|transit|car service|dmv)\b/i, 'Transportation'],
  [/\b(starbucks|coffee|restaurant|lunch|dinner|breakfast|cafe|catering|doordash|ubereats|grubhub|bar|pub|meal|food|pizza|snack)\b/i, 'Meals & Entertainment'],
  [/\b(staples|officeworks|printer|ink|paper|stationery|supplies|furniture|chair|desk|monitor|keyboard|hardware|tools?)\b/i, 'Supplies'],
];

function keywordCategory(text: string): string {
  for (const [re, category] of RULES) {
    if (re.test(text)) return category;
  }
  return 'Other';
}

/** Ask the model for a category, with rules as the backstop. */
async function categorise(vendor: string, description: string): Promise<string> {
  const haystack = `${vendor} ${description}`;
  const guess = keywordCategory(haystack);
  if (guess !== 'Other') return guess;
  try {
    const raw = await complete(
      `Reply with ONLY one of these category names, nothing else: ${CATEGORIES.join(', ')}`,
      `Vendor: ${vendor}\nWhat it was for: ${description || 'not stated'}`,
      20
    );
    const answer = raw
      .trim()
      .replace(/^["']|["']$/g, '')
      .split('\n')[0]!
      .trim();
    return CATEGORIES.includes(answer) ? answer : 'Other';
  } catch {
    return 'Other';
  }
}

const ANSWER_SYSTEM = `You answer questions about someone's bookkeeping records using ONLY the figures provided.

Rules:
- Every number you state must come from the data. Never estimate or invent.
- If the data does not contain the answer, say so plainly.
- Be brief: two or three sentences, or a short list. No preamble.
- Format money as $X.XX.`;

export interface AgentReply {
  reply: string;
  intent: string;
  logged?: Expense;
  degraded?: boolean;
  detail?: string;
}

export async function handleMessage(message: string): Promise<AgentReply> {
  if (!llmConfigured()) {
    const fallback = parseExpensePhrase(message);
    if (fallback) {
      return logExpense({ ...fallback, description: message });
    }
    throw new LlmError('OPENROUTER_API_KEY is not set on this deployment', []);
  }

  let planned: Planned;
  try {
    planned = await plan(message);
  } catch (err) {
    // The planner is the fragile part with free models. Rather than fail the
    // message, fall back to a pattern for logging and to "show me everything"
    // for questions, so the assistant keeps working while the pool is busy.
    const fallback = parseExpensePhrase(message);
    if (fallback) {
      return logExpense(
        {
          ...fallback,
          category: await categorise(fallback.vendor, fallback.description),
          description: message,
        },
        err
      );
    }
    if (looksLikeQuestion(message)) {
      const expenses = await getAll();
      const { reply, degraded, detail } = await answerQuestion(message, {
        expenses,
        label: 'in total',
      });
      return {
        reply,
        intent: 'question',
        degraded: degraded ? true : undefined,
        detail: detail ?? (err instanceof Error ? err.message : undefined),
      };
    }
    return {
      reply:
        "I couldn't turn that into an expense. Include a vendor, for example \"spent $50 at Starbucks for coffee\". You can also log it in the form above.",
      intent: 'unknown',
      degraded: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (planned.intent === 'log_expense') {
    const clean = normaliseExpense(planned.expense);
    if (!clean) {
      return {
        reply:
          'I could tell you meant to log an expense, but I need a vendor and an amount. For example: "spent $50 at Starbucks for coffee".',
        intent: 'log_expense',
      };
    }
    return logExpense(clean);
  }

  if (planned.intent === 'question') {
    const q = planned.question;
    const period = resolvePeriod(q?.period);
    const filter: ExpenseFilter = {};
    if (period.start) filter.start_date = period.start;
    if (period.end) filter.end_date = period.end;
    const vendor = str(q?.vendor);
    if (vendor) filter.vendor = vendor;
    const category = str(q?.category);
    if (CATEGORIES.includes(category)) filter.category = category;

    const expenses = await getAll(filter);
    const { reply, degraded, detail } = await answerQuestion(message, {
      expenses,
      label: period.label,
    });
    return {
      reply,
      intent: 'question',
      degraded: degraded ? true : undefined,
      detail,
    };
  }

  return {
    reply:
      /^\s*(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|bye)\b/i.test(message)
        ? 'Ask me to log an expense ("spent $50 at Starbucks for coffee") or ask about your books ("what did I spend on software last month?").'
        : 'I could not turn that into an expense. Include a vendor, for example "spent $50 at Starbucks for coffee". You can also log it in the form above.',
    intent: 'unknown',
  };
}

function looksLikeQuestion(message: string): boolean {
  return /\b(what|how much|how many|which|show|list|summar|tell me|total|spent|expense|average)\b/i.test(
    message
  );
}

interface AnswerContext {
  expenses: Expense[];
  label: string;
}

async function answerQuestion(message: string, ctx: AnswerContext) {
  const data = summarise(ctx.expenses, ctx.label);
  try {
    const answer = await complete(
      ANSWER_SYSTEM,
      `Question: ${message}\n\nBookkeeping data:\n${data}`,
      300
    );
    return { reply: answer.trim(), degraded: false };
  } catch (err) {
    // The figures are already computed, so a busy model must not deny the
    // user their own numbers. Return the summary unphrased instead.
    return {
      reply: `The assistant is busy, so here are the figures:\n\n${data}`,
      degraded: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function logExpense(
  fields: {
    vendor: string;
    amount: number;
    currency: string;
    category: string;
    description: string;
    date: string;
    inferred?: boolean;
  },
  cause?: unknown
): Promise<AgentReply> {
  const { amount_usd, rate } = convertToUsd(fields.amount, fields.currency);
  const input: CreateExpenseInput = {
    date: fields.date,
    vendor: fields.vendor,
    description: fields.description,
    category: fields.category,
    currency: fields.currency,
    amount: fields.amount,
    amount_usd,
    exchange_rate: rate,
    payment_method: 'other',
    tags: [],
    notes: '',
  };
  const saved = await create(input);
  const rateNote =
    rate && rate !== 1 ? ` at ${rate} USD/${fields.currency}` : '';
  return {
    reply: `Logged ${fields.currency} ${fields.amount.toFixed(2)}${rateNote} at ${fields.vendor} as ${fields.category}.`,
    intent: 'log_expense',
    logged: saved,
    degraded: fields.inferred ? true : undefined,
    detail: fields.inferred
      ? `Parsed without the model: ${cause instanceof Error ? cause.message : ''}`
      : undefined,
  };
}