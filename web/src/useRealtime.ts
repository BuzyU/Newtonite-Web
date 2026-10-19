import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext';

export interface RealtimeState {
  isConnected: boolean;
  isPollingFallback: boolean;
  status: 'live' | 'reconnecting' | 'polling' | 'disconnected';
  statusText: 'live' | 'reconnecting' | 'polling' | 'disconnected';
}

export function useRealtime(): RealtimeState {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [isConnected, setIsConnected] = useState(false);
  const [isPollingFallback, setIsPollingFallback] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  useEffect(() => {
    if (!user) {
      setIsConnected(false);
      setIsPollingFallback(false);
      return;
    }

    let eventSource: EventSource | null = null;
    let pollInterval: any = null;
    let reconnectTimeout: any = null;
    let isMounted = true;

    function connectSse() {
      if (!isMounted) return;

      try {
        eventSource = new EventSource('/api/v1/events', { withCredentials: true });

        eventSource.addEventListener('connected', () => {
          if (!isMounted) return;
          setIsConnected(true);
          setIsPollingFallback(false);
          setConsecutiveFailures(0);
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        });

        eventSource.addEventListener('item_update', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            // Invalidate item list queries and attention dashboard
            queryClient.invalidateQueries({ queryKey: ['items'] });
            queryClient.invalidateQueries({ queryKey: ['attention'] });
            if (data.itemId) {
              queryClient.invalidateQueries({ queryKey: ['item', data.itemId] });
              queryClient.invalidateQueries({ queryKey: ['item-activity', data.itemId] });
              queryClient.invalidateQueries({ queryKey: ['item-comments', data.itemId] });
            }
          } catch {
            // ignore malformed data
          }
        });

        eventSource.addEventListener('resync', () => {
          // Broad resync requested by server (e.g. after LISTEN client reconnected)
          queryClient.invalidateQueries({ queryKey: ['items'] });
          queryClient.invalidateQueries({ queryKey: ['attention'] });
        });

        eventSource.onerror = () => {
          if (!isMounted) return;
          setIsConnected(false);
          eventSource?.close();
          eventSource = null;

          setConsecutiveFailures((prev) => {
            const next = prev + 1;
            // After 2 consecutive failures, activate 15s polling fallback
            if (next >= 2 && !pollInterval) {
              setIsPollingFallback(true);
              pollInterval = setInterval(() => {
                queryClient.invalidateQueries({ queryKey: ['items'] });
                queryClient.invalidateQueries({ queryKey: ['attention'] });
              }, 15000);
            }
            return next;
          });

          // Schedule reconnection attempt with backoff
          const delay = Math.min(2000 * Math.pow(1.5, consecutiveFailures), 30000);
          reconnectTimeout = setTimeout(connectSse, delay);
        };
      } catch {
        setIsConnected(false);
      }
    }

    connectSse();

    return () => {
      isMounted = false;
      if (eventSource) eventSource.close();
      if (pollInterval) clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [user, queryClient, consecutiveFailures]);

  let statusText: RealtimeState['statusText'] = 'disconnected';
  if (isConnected) {
    statusText = 'live';
  } else if (isPollingFallback) {
    statusText = 'polling';
  } else if (consecutiveFailures > 0) {
    statusText = 'reconnecting';
  }

  return {
    isConnected,
    isPollingFallback,
    status: statusText,
    statusText,
  };
}
