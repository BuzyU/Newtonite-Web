export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: any;
  requestId?: string;
  current_assignee?: { id: string; name: string; email?: string };
  currentAssignee?: { id: string; name: string; email?: string };
  current_version?: number;
  current_item?: any;
}

export class ApiError extends Error {
  public status: number;
  public error: ApiErrorPayload;
  public headers: Headers;

  constructor(status: number, error: ApiErrorPayload, headers: Headers) {
    super(error.message || `API error with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
    this.headers = headers;
  }

  get code(): string {
    return this.error.code || `HTTP_${this.status}`;
  }

  get details(): any {
    return this.error.details;
  }

  get requestId(): string | undefined {
    return this.error.requestId;
  }
}

// Global wake-up listener callback for Render free-tier cold starts
type WakeupListener = (isWaking: boolean) => void;
const wakeupListeners = new Set<WakeupListener>();

export const isServerWaking = {
  subscribe(cb: WakeupListener): () => void {
    wakeupListeners.add(cb);
    return () => wakeupListeners.delete(cb);
  },
};

export function subscribeWakeupState(cb: WakeupListener): () => void {
  wakeupListeners.add(cb);
  return () => wakeupListeners.delete(cb);
}

function notifyWakeup(isWaking: boolean) {
  wakeupListeners.forEach((cb) => cb(isWaking));
}

export interface RequestOptions extends RequestInit {
  idempotencyKey?: string;
  ifMatch?: string | number;
  maxRetries?: number;
  skipAuthRedirect?: boolean;
}

/**
 * Universal API fetch wrapper:
 * - Uses relative base /api/v1 (proxied by Vite in dev and Vercel in production)
 * - Attaches custom header X-Requested-With (CSRF defence)
 * - Generates stable Idempotency-Key per intent and reuses it across automatic retries
 * - Emits wake-up notification if request takes >3 seconds (Render free tier cold start)
 * - Parses ETag headers and error envelopes
 */
export async function apiFetch<T = any>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<{ data: T; headers: Headers; etag?: string }> {
  const url = endpoint.startsWith('/')
    ? endpoint.startsWith('/api/v1')
      ? endpoint
      : `/api/v1${endpoint}`
    : `/api/v1/${endpoint}`;

  const headers = new Headers(options.headers || {});
  headers.set('X-Requested-With', 'XMLHttpRequest');

  const method = (options.method || 'GET').toUpperCase();
  const maxRetries = options.maxRetries ?? 0;

  // Attach Idempotency-Key on mutating requests if not already provided
  // Stored in headers so all automatic retries reuse the exact same key (CONC-02)
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    if (!headers.has('Idempotency-Key')) {
      const generatedKey =
        options.idempotencyKey || `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      headers.set('Idempotency-Key', generatedKey);
    }
  }

  // Attach If-Match for optimistic updates
  if (options.ifMatch !== undefined) {
    const etagValue = typeof options.ifMatch === 'number' ? `"${options.ifMatch}"` : options.ifMatch;
    headers.set('If-Match', etagValue);
  }

  let attempt = 0;
  while (true) {
    // Start 3-second cold-start timer
    let isWakingNotified = false;
    const wakeupTimer = setTimeout(() => {
      isWakingNotified = true;
      notifyWakeup(true);
    }, 3000);

    try {
      const response = await fetch(url, {
        ...options,
        headers, // Reuses exact same headers and Idempotency-Key across retries
        credentials: 'include', // Include httpOnly session cookie
      });

      clearTimeout(wakeupTimer);
      if (isWakingNotified) {
        notifyWakeup(false);
      }

      // Automatically retry transient 503 (e.g. database connection timeout during cold-start)
      if (response.status === 503 && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
        continue;
      }

      const responseEtag = response.headers.get('ETag') || undefined;

      // Handle 204 No Content
      if (response.status === 204) {
        return { data: {} as T, headers: response.headers, etag: responseEtag };
      }

      const contentType = response.headers.get('content-type') || '';
      let responseData: any;
      if (contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      if (!response.ok) {
        const errorPayload: ApiErrorPayload = responseData?.error || {
          code: `HTTP_${response.status}`,
          message: typeof responseData === 'string' ? responseData : 'An unexpected error occurred.',
        };

        // Only trigger hard redirect to /login if 401 occurs while on a protected internal route.
        // Never redirect on probe requests, root landing ('/'), onboarding, or auth callbacks.
        const currentPath = window.location.pathname;
        const isPublicPath =
          currentPath === '/' ||
          currentPath.startsWith('/login') ||
          currentPath.startsWith('/onboard') ||
          currentPath.startsWith('/register') ||
          currentPath.startsWith('/auth');

        if (response.status === 401 && !isPublicPath && !options.skipAuthRedirect) {
          window.location.href = `/login?redirect=${encodeURIComponent(
            currentPath + window.location.search
          )}`;
        }

        throw new ApiError(response.status, errorPayload, response.headers);
      }

      return {
        data: responseData as T,
        headers: response.headers,
        etag: responseEtag,
      };
    } catch (err: any) {
      clearTimeout(wakeupTimer);
      if (isWakingNotified) {
        notifyWakeup(false);
      }

      // If it's a network failure (fetch threw) and retries remain, retry with same key
      if (!(err instanceof ApiError) && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
        continue;
      }

      throw err;
    }
  }
}

export const api = {
  get: async <T = any>(endpoint: string, options: RequestOptions = {}): Promise<T> => {
    const res = await apiFetch<T>(endpoint, { ...options, method: 'GET' });
    return res.data;
  },
  post: async <T = any>(endpoint: string, body?: any, options: RequestOptions = {}): Promise<T> => {
    const headers = new Headers(options.headers || {});
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await apiFetch<T>(endpoint, {
      ...options,
      method: 'POST',
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return res.data;
  },
  patch: async <T = any>(endpoint: string, body?: any, options: RequestOptions = {}): Promise<T> => {
    const headers = new Headers(options.headers || {});
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await apiFetch<T>(endpoint, {
      ...options,
      method: 'PATCH',
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return res.data;
  },
  delete: async <T = any>(endpoint: string, options: RequestOptions = {}): Promise<T> => {
    const res = await apiFetch<T>(endpoint, { ...options, method: 'DELETE' });
    return res.data;
  },
};
