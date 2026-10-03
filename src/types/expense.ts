export interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface Receipt {
  filename: string | null;
  path: string | null;
  extracted: boolean;
}

export interface Expense {
  id: string;
  date: string;
  vendor: string;
  description: string;
  category: string;
  currency: string;
  amount: number;
  amount_usd: number;
  exchange_rate: number | null;
  payment_method: string;
  receipt: Receipt;
  line_items: LineItem[];
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Fact {
  id: string;
  key: string;
  value: unknown;
  source: 'user' | 'inferred' | 'system';
  notes: string;
  created_at: string;
}

export interface CreateExpenseInput {
  date?: string;
  vendor: string;
  description?: string;
  category?: string;
  currency?: string;
  amount: number;
  amount_usd?: number;
  exchange_rate?: number | null;
  payment_method?: string;
  line_items?: LineItem[];
  tags?: string[];
  notes?: string;
  receipt?: Receipt;
}

export interface ExpenseFilter {
  category?: string;
  vendor?: string;
  start_date?: string;
  end_date?: string;
  tags?: string[];
  currency?: string;
}
