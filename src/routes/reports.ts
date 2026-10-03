import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getAll } from '../services/expense-store.js';
import { AppError } from '../middleware/error.js';
import type { ExpenseFilter } from '../types/expense.js';

const router = Router();

router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: ExpenseFilter = {};
    if (req.query.start_date) filter.start_date = req.query.start_date as string;
    if (req.query.end_date) filter.end_date = req.query.end_date as string;

    const expenses = await getAll(filter);
    const total = expenses.reduce((sum, e) => sum + e.amount_usd, 0);
    const byCategory: Record<string, number> = {};
    const byCurrency: Record<string, number> = {};
    let count = expenses.length;

    for (const e of expenses) {
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_usd;
      byCurrency[e.currency] = (byCurrency[e.currency] || 0) + 1;
    }

    res.json({ total, count, by_category: byCategory, by_currency: byCurrency });
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: ExpenseFilter = {};
    if (req.query.start_date) filter.start_date = req.query.start_date as string;
    if (req.query.end_date) filter.end_date = req.query.end_date as string;
    if (req.query.category) filter.category = req.query.category as string;

    const expenses = await getAll(filter);
    const headers = 'Date,Vendor,Description,Category,Amount,Currency,Amount (USD),Payment Method,Tags,Notes';
    const rows = expenses.map(e =>
      [
        e.date,
        `"${e.vendor.replace(/"/g, '""')}"`,
        `"${e.description.replace(/"/g, '""')}"`,
        e.category,
        e.amount.toFixed(2),
        e.currency,
        e.amount_usd.toFixed(2),
        e.payment_method,
        `"${e.tags.join('; ')}"`,
        `"${e.notes.replace(/"/g, '""')}"`,
      ].join(',')
    );
    const csv = [headers, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/chat-log', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.query;
    if (!text || typeof text !== 'string') {
      throw new AppError(400, 'text query parameter is required');
    }

    const pattern = /(?:logged?|spent?|paid?|bought?|purchased?)\s+(?:USD\s+)?\$?([\d,.]+)\s+(?:at|for|on|to)\s+(.+?)(?:\s+(?:for|on|at)\s+(.+))?$/i;
    const match = text.match(pattern);

    if (!match) {
      res.json({ parsed: false, message: 'Could not parse expense. Try: "spent $50 at Starbucks for coffee"' });
      return;
    }

    const amount = parseFloat((match[1] ?? '').replace(/,/g, ''));
    const vendor = (match[2] ?? '').trim();
    const description = match[3]?.trim() || '';

    res.json({
      parsed: true,
      preview: { vendor, amount, description, currency: 'USD' },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
