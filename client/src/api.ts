export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface ApiOk<T> { ok: true; data: T }
interface ApiFail { ok: false; error: ApiError }

type ApiResult<T> = ApiOk<T> | ApiFail;

async function request<T = unknown>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init
    });
    let body: unknown = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const message = (body as { error?: string })?.error || `Request failed (${res.status})`;
      return { ok: false, error: new ApiError(message, res.status) };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err };
    return { ok: false, error: new ApiError((err as Error).message || 'Network error', 0) };
  }
}

export async function get<T>(url: string): Promise<ApiResult<T>> {
  return request<T>(url);
}

export async function post<T = Record<string, unknown>>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function del<T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'DELETE' });
}

export async function put<T = Record<string, unknown>>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Upload a File with multipart/form-data. */
export async function upload<T = Record<string, unknown>>(url: string, field: string, file: File, extra: Record<string, string> = {}): Promise<ApiResult<T>> {
  const form = new FormData();
  form.append(field, file);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const message = (body as { error?: string })?.error || `Upload failed (${res.status})`;
      return { ok: false, error: new ApiError(message, res.status) };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: new ApiError((err as Error).message || 'Network error', 0) };
  }
}

/** Trigger a browser download of a GET endpoint (auth-free local panel). */
export function downloadUrl(url: string): void {
  window.location.href = url;
}
