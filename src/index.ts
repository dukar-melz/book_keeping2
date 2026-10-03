import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { initExpenseStore } from './services/expense-store.js';
import { initFactStore } from './services/fact-store.js';
import { errorHandler } from './middleware/error.js';
import expenseRoutes from './routes/expenses.js';
import receiptRoutes from './routes/receipts.js';
import reportRoutes from './routes/reports.js';
import { supabaseConfigured, probe } from './services/supabase.js';

const agentHome = process.env.PI_CODING_AGENT_DIR || join(import.meta.dirname, '..', 'agent-home');
const memoryDir = join(agentHome, 'memory');

initExpenseStore(join(memoryDir, 'expenses.json'));
initFactStore(join(memoryDir, 'facts.json'));

/** Vercel bundles sources into /var/task, so the directory that held
 * public/ at build time is not where it lives at runtime. Probe candidates. */
function resolvePublicDir(): string {
  const candidates = [
    join(import.meta.dirname, '..', 'public'),
    join(import.meta.dirname, 'public'),
    join(process.cwd(), 'public'),
    '/var/task/public',
  ];
  return candidates.find(dir => existsSync(join(dir, 'index.html'))) ?? candidates[0]!;
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const publicDir = resolvePublicDir();
app.use(express.static(publicDir));
app.use(express.json());
app.use('/expenses', expenseRoutes);
app.use('/receipts', receiptRoutes);
app.use('/reports', reportRoutes);

app.get('/health', async (_req, res) => {
  const storage = supabaseConfigured() ? 'supabase' : 'json-files';
  if (!supabaseConfigured()) {
    res.json({ ok: true, storage });
    return;
  }
  // Report whether the database is actually usable. "storage: supabase" alone
  // only proves env vars exist, which hid a missing-schema failure for a while.
  const db = await probe();
  res.json({ ok: db.reachable, storage, database: db });
});

app.use(errorHandler);

// Vercel imports the app from api/index.ts; only listen when run directly.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Bookkeeping agent running on http://localhost:${PORT}`);
    console.log(`Storage: ${supabaseConfigured() ? 'Supabase' : join(memoryDir, 'expenses.json')}`);
  });
}

export default app;