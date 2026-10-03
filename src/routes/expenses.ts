import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getAll, getById, create, update, remove } from '../services/expense-store.js';
import { convertToUsd } from '../services/currency.js';
import { AppError } from '../middleware/error.js';
import type { CreateExpenseInput, ExpenseFilter } from '../types/expense.js';

const router = Router();

function idParam(req: Request): string {
  const { id } = req.params;
  return Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
}

/** A currency-only patch still needs the amount from the stored row. */
async function currentCurrency(id: string): Promise<string | undefined> {
  const existing = await getById(id);
  return existing?.currency;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: ExpenseFilter = {};
    if (req.query.category) filter.category = req.query.category as string;
    if (req.query.vendor) filter.vendor = req.query.vendor as string;
    if (req.query.start_date) filter.start_date = req.query.start_date as string;
    if (req.query.end_date) filter.end_date = req.query.end_date as string;
    if (req.query.currency) filter.currency = req.query.currency as string;
    if (req.query.tags) filter.tags = (req.query.tags as string).split(',');

    const expenses = await getAll(filter);
    res.json(expenses);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expense = await getById(idParam(req));
    if (!expense) throw new AppError(404, 'Expense not found');
    res.json(expense);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreateExpenseInput = req.body;
    if (!input.vendor || input.amount == null) {
      throw new AppError(400, 'vendor and amount are required');
    }

    const { amount_usd, rate } = convertToUsd(input.amount, input.currency || 'USD');
    input.amount_usd = amount_usd;
    input.exchange_rate = rate;

    const expense = await create(input);
    res.status(201).json(expense);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const patch: Record<string, unknown> = { ...req.body };

    // Reports total amount_usd, so editing amount or currency has to refresh
    // the conversion. Otherwise the edit saves fine and every total silently
    // keeps the old figure.
    const touchesMoney = patch.amount != null || patch.currency != null;
    if (touchesMoney && patch.amount_usd == null) {
      const amount = patch.amount != null ? Number(patch.amount) : undefined;
      const currency =
        (patch.currency as string | undefined) ??
        (await currentCurrency(idParam(req))) ??
        'USD';
      if (amount != null && !Number.isNaN(amount)) {
        const { amount_usd, rate } = convertToUsd(amount, currency);
        patch.amount = amount;
        patch.amount_usd = amount_usd;
        patch.exchange_rate = rate;
        patch.currency = currency;
      }
    }

    const expense = await update(idParam(req), patch);
    if (!expense) throw new AppError(404, 'Expense not found');
    res.json(expense);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await remove(idParam(req));
    if (!ok) throw new AppError(404, 'Expense not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
