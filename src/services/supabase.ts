const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function supabaseConfigured(): boolean {
  return Boolean(SUPA_URL && SUPA_KEY);
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPA_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: headers(init.headers as Record<string, string> | undefined),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function supabaseTable(table: string, query = ''): string {
  return `/rest/v1/${table}${query}`;
}

export function selectRows<T>(table: string, query: string): Promise<T[]> {
  return request<T[]>(supabaseTable(table, query), { method: 'GET' });
}

export function insertRow<T>(table: string, row: unknown): Promise<T[]> {
  return request<T[]>(supabaseTable(table), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
}

export function updateRow<T>(
  table: string,
  filter: string,
  patch: unknown
): Promise<T[]> {
  return request<T[]>(supabaseTable(table, filter), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

export function deleteRows(table: string, filter: string): Promise<void> {
  return request<void>(supabaseTable(table, filter), { method: 'DELETE' });
}

export function countRows(table: string, filter = ''): Promise<number> {
  return request<number>(supabaseTable(table, `${filter}&select=id`), {
    method: 'HEAD',
  });
}

export async function uploadToBucket(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const res = await fetch(
    `${SUPA_URL.replace(/\/$/, '')}/storage/v1/object/${bucket}/${path}`,
    {
      method: 'POST',
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: new Uint8Array(body),
    }
  );
  if (!res.ok) {
    throw new Error(`Supabase Storage ${res.status}: ${await res.text()}`);
  }
}