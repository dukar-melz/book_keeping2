import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';
import { initExpenseStore } from './services/expense-store.js';
import { initFactStore } from './services/fact-store.js';
import { errorHandler } from './middleware/error.js';
import expenseRoutes from './routes/expenses.js';
import receiptRoutes from './routes/receipts.js';
import reportRoutes from './routes/reports.js';
import { supabaseConfigured } from './services/supabase.js';

const agentHome = process.env.PI_CODING_AGENT_DIR || join(import.meta.dirname, '..', 'agent-home');
const memoryDir = join(agentHome, 'memory');

initExpenseStore(join(memoryDir, 'expenses.json'));
initFactStore(join(memoryDir, 'facts.json'));

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const publicDir = join(import.meta.dirname, '..', 'public');
app.use(express.static(publicDir));
app.use(express.json());
app.use('/expenses', expenseRoutes);
app.use('/receipts', receiptRoutes);
app.use('/reports', reportRoutes);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    storage: supabaseConfigured() ? 'supabase' : 'json-files',
  });
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