import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { create } from '../services/expense-store.js';
import { convertToUsd } from '../services/currency.js';
import { AppError } from '../middleware/error.js';
import { supabaseConfigured, uploadToBucket } from '../services/supabase.js';

const BUCKET = process.env.SUPABASE_BUCKET || 'receipts';
const ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
];

// Vercel caps request bodies at 4.5 MB, so the 10 MB local ceiling cannot be
// honoured in production. Keep uploads under the platform limit.
const MAX_BYTES = supabaseConfigured() ? 4 * 1024 * 1024 : 10 * 1024 * 1024;

const RECEIPT_DIR = join(import.meta.dirname, '..', '..', 'memory', 'receipts');

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) {
  if (ALLOWED.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(400, 'Only images and PDFs are allowed'));
  }
}

function makeUpload() {
  if (supabaseConfigured()) {
    return multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_BYTES },
      fileFilter,
    });
  }

  // On a read-only filesystem (Vercel) we cannot spool uploads to disk, so
  // fall back to buffering in memory rather than failing at import time.
  let diskAvailable = true;
  try {
    if (!existsSync(RECEIPT_DIR)) {
      mkdirSync(RECEIPT_DIR, { recursive: true });
    }
  } catch {
    diskAvailable = false;
  }

  if (!diskAvailable) {
    return multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_BYTES },
      fileFilter,
    });
  }

  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, RECEIPT_DIR),
      filename: (_req, file, cb) => {
        const ext = file.originalname.split('.').pop() || 'bin';
        cb(null, `${randomUUID()}.${ext}`);
      },
    }),
    limits: { fileSize: MAX_BYTES },
    fileFilter,
  });
}

const upload = makeUpload();
const router = Router();

router.post('/', upload.single('receipt'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(400, 'No receipt file provided');

    const file = req.file;
    const metadata = req.body as Record<string, string>;

    const amount = parseFloat(metadata.amount!);
    if (!metadata.vendor || isNaN(amount)) {
      throw new AppError(400, 'vendor and amount are required in request body');
    }

    let storedPath: string;
    if (supabaseConfigured()) {
      const ext = file.originalname.split('.').pop() || 'bin';
      storedPath = `${randomUUID()}.${ext}`;
      await uploadToBucket(BUCKET, storedPath, file.buffer, file.mimetype);
    } else {
      storedPath = file.filename ?? '';
    }

    const { amount_usd, rate } = convertToUsd(amount, metadata.currency || 'USD');

    const expense = await create({
      vendor: metadata.vendor,
      amount,
      amount_usd,
      exchange_rate: rate,
      description: metadata.description || `Receipt: ${file.originalname}`,
      category: metadata.category || 'Other',
      currency: metadata.currency || 'USD',
      date: metadata.date || undefined,
      payment_method: metadata.payment_method || 'card',
      tags: metadata.tags ? [metadata.tags] : [],
      notes: metadata.notes || '',
      receipt: {
        filename: file.originalname,
        path: storedPath,
        extracted: false,
      },
    });

    res.status(201).json(expense);
  } catch (err) {
    next(err);
  }
});

export default router;