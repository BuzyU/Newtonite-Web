import { useEffect, useState, useRef } from 'react';
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
  const [status, setStatus] = useState<RealtimeState['status']>('disconnected');
  const failureCountRef = useRef(0);

  useEffect(() => {
    if (!user) {
      setIsConnected(false);
      setIsPollingFallback(false);
      setStatus('disconnected');
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
          setStatus('live');
          failureCountRef.current = 0;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        });

        eventSource.addEventListener('item_update', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
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
          queryClient.invalidateQueries({ queryKey: ['items'] });
          queryClient.invalidateQueries({ queryKey: ['attention'] });
        });

        eventSource.onerror = () => {
          if (!isMounted) return;
          setIsConnected(false);
          eventSource?.close();
          eventSource = null;

          failureCountRef.current += 1;
          const fails = failureCountRef.current;

          if (fails >= 2 && !pollInterval) {
            setIsPollingFallback(true);
            setStatus('polling');
            pollInterval = setInterval(() => {
              queryClient.invalidateQueries({ queryKey: ['items'] });
              queryClient.invalidateQueries({ queryKey: ['attention'] });
            }, 15000);
          } else {
            setStatus('reconnecting');
          }

          // Backoff calculation using stable ref
          const delay = Math.min(2000 * Math.pow(1.5, Math.min(fails, 6)), 30000);
          reconnectTimeout = setTimeout(connectSse, delay);
        };
      } catch {
        setIsConnected(false);
        setStatus('disconnected');
      }
    }

    connectSse();

    return () => {
      isMounted = false;
      if (eventSource) eventSource.close();
      if (pollInterval) clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [user, queryClient]);

  return {
    isConnected,
    isPollingFallback,
    status,
    statusText: status,
  };
}
