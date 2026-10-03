const EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.26,
  JPY: 0.0067,
  CAD: 0.73,
  AUD: 0.65,
  CHF: 1.10,
  CNY: 0.14,
  INR: 0.012,
  MXN: 0.054,
  BRL: 0.18,
  KRW: 0.00075,
  SEK: 0.093,
  NOK: 0.091,
  DKK: 0.145,
  NZD: 0.60,
  SGD: 0.74,
  HKD: 0.128,
  THB: 0.028,
  ZAR: 0.053,
};

export function convertToUsd(amount: number, fromCurrency: string): { amount_usd: number; rate: number | null } {
  if (fromCurrency === 'USD') return { amount_usd: amount, rate: null };
  const rate = EXCHANGE_RATES[fromCurrency.toUpperCase()];
  if (!rate) return { amount_usd: amount, rate: null };
  return { amount_usd: Math.round(amount * rate * 100) / 100, rate };
}

export function getSupportedCurrencies(): string[] {
  return Object.keys(EXCHANGE_RATES);
}
