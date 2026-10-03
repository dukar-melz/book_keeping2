# Bookkeeping Agent

An expense-tracking agent built with an Express 5 + TypeScript backend and a single-page
frontend. It records expenses, normalises foreign currencies into USD, accepts receipt
uploads, and produces summaries and CSV exports.

It also carries a small **key–value fact store** — the agent's long-term memory for facts
about the business that aren't expenses (default categories, recurring vendors, tax rate,
and so on).

Deployed on **Vercel**, with **Supabase Postgres** for persistence.

---

## Architecture

```
src/
  index.ts              App wiring, static hosting, store initialisation
  routes/
    expenses.ts         CRUD for expense records
    receipts.ts         Receipt upload → expense creation
    reports.ts          Summary, CSV export, natural-language expense parsing
  services/
    expense-store.ts    Expense persistence
    fact-store.ts       Key–value fact persistence
    currency.ts         Fixed-rate conversion to USD
    supabase.ts         Minimal PostgREST + Storage client
  middleware/
    error.ts            AppError and the central error handler
  types/
    expense.ts          Expense, Fact, and filter shapes
api/index.ts            Vercel function entrypoint
supabase/schema.sql     Table definitions and the receipts bucket
```

### Storage is swappable

Both stores expose the same functions regardless of backend. If `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set, they read and write Postgres via PostgREST; otherwise
they fall back to JSON files on disk. That means the app runs with no external services at
all during local development, and the same code deploys to Vercel without modification.

```
initExpenseStore(path) ──► configured? ──► PostgREST  ──► public.expenses
                                        └──► no ────────► memory/expenses.json
```

Receipt uploads follow the same pattern: `multer` writes to disk locally, but on Vercel the
filesystem is read-only, so the file is buffered in memory and pushed to Supabase Storage
instead. Only the resulting path is stored on the expense record.

### Filters

`GET /expenses` supports `category`, `vendor`, `start_date`, `end_date`, `currency` and
`tags`. With Postgres these become database filters (`eq.`, `ilike.`, `gte.`, `lte.`, `ov.`),
so filtering happens in the database rather than in memory. With the JSON backend the same
filters are applied in JavaScript. Vendor matching is case-insensitive in both.

### Currency handling

`currency.ts` converts every expense to USD on write, so reports never have to reason about
mixed currencies. Both the original amount and the USD equivalent are stored, along with the
rate used, so a historical rate can always be audited.

### Natural-language parsing

`GET /reports/chat-log?text=...` extracts a structured expense preview from plain text using
a regular expression. `"spent $50 at Starbucks for coffee"` yields vendor `Starbucks`, amount
`50`, description `coffee`. This drives the quick-entry affordance in the UI without
requiring a separate model call.

---

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check; reports the active storage backend |
| `GET` | `/expenses` | List expenses. Accepts the filters above |
| `GET` | `/expenses/:id` | Fetch one expense |
| `POST` | `/expenses` | Create an expense |
| `PATCH` | `/expenses/:id` | Update an expense |
| `DELETE` | `/expenses/:id` | Delete an expense |
| `POST` | `/receipts` | Upload a receipt (multipart); creates the expense |
| `GET` | `/reports/summary` | Total, count, and totals per category and currency |
| `GET` | `/reports/export` | CSV download |
| `GET` | `/reports/chat-log` | Parse an expense out of free text |

`POST /expenses` body:

```json
{
  "vendor": "Starbucks",
  "amount": 50,
  "category": "Meals",
  "currency": "USD",
  "payment_method": "card",
  "tags": ["coffee"],
  "notes": "morning meeting"
}
```

`POST /receipts` takes `multipart/form-data` with a `receipt` file plus the same fields in
the form body. Images and PDFs up to 4 MB are accepted.

---

## Local setup

Requires Node 24 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. With no Supabase variables set, expenses are written to
`memory/expenses.json` and facts to `memory/facts.json`.

```bash
npm run build   # type-check with tsc --noEmit
```

---

## Deploying to Vercel

1. Create a Supabase project and run `supabase/schema.sql` in the SQL editor. This creates the
   `expenses` and `facts` tables and the private `receipts` storage bucket.
2. Import this repo into Vercel.
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_BUCKET`.
4. Deploy.

`vercel.json` routes all traffic to `api/index.ts`, which re-exports the Express app. The app
only calls `listen()` when `VERCEL` is not set, so the same entrypoint works locally and
serverless.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | production | Postgres project URL. Blank → JSON files |
| `SUPABASE_SERVICE_ROLE_KEY` | production | Postgres auth. Blank → JSON files |
| `SUPABASE_BUCKET` | no | Receipt bucket name. Defaults to `receipts` |
| `PI_CODING_AGENT_DIR` | no | Where the local JSON memory store lives |
| `PORT` | no | Local port. Defaults to `3000` |