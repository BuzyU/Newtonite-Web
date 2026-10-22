import { useState, useCallback } from 'react';

/**
 * Hook to maintain a stable Idempotency-Key for a specific user action/intent.
 *
 * Requirements:
 * 1. The key remains identical across re-renders and across errors (e.g. transient 5xx,
 *    network drops, or manual user retries clicking the button again).
 * 2. The key is rotated (reset) ONLY upon a successful mutation or when a fresh
 *    intent begins (e.g. modal opens afresh).
 */
export function useIdempotencyKey(prefix = 'req') {
  const generate = useCallback(() => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }, [prefix]);

  const [key, setKey] = useState<string>(() => generate());

  const reset = useCallback(() => {
    setKey(generate());
  }, [generate]);

  return { key, reset };
}
