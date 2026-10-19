import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface DeadLetterEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const DeadLettersPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<{ events: DeadLetterEvent[] }>({
    queryKey: ['dead-letters'],
    queryFn: () => api.get<{ events: DeadLetterEvent[] }>('/admin/dead-letters'),
  });

  const retryMutation = useMutation({
    mutationFn: (eventId: string) => api.post(`/admin/dead-letters/${eventId}/retry`),
    onMutate: (id) => setRetryingId(id),
    onSettled: () => {
      setRetryingId(null);
      queryClient.invalidateQueries({ queryKey: ['dead-letters'] });
    },
    onError: (err: any) => {
      alert(err.message || 'Retry failed');
    },
  });

  const events = data?.events || [];

  return (
    <div style={{ maxWidth: '1040px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
            Dead-Letter Queue (Outbox Admin)
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '2px', marginBottom: 0 }}>
            Events that repeatedly failed outbox worker processing (max 5 attempts) are parked here.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => refetch()} style={{ fontSize: '12px' }}>
          ↻ Refresh
        </button>
      </div>

      <div
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}
      >
        {isLoading ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <div className="skeleton" style={{ height: '32px', marginBottom: '8px' }} />
            <div className="skeleton" style={{ height: '32px' }} />
          </div>
        ) : error ? (
          <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--color-danger)' }}>
            {(error as any).message || 'Failed to load dead-letter queue. Requires admin privileges.'}
          </div>
        ) : events.length === 0 ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
              Zero Dead Letters
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
              The outbox worker queue is healthy. No failed events require administrative attention.
            </p>
          </div>
        ) : (
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ width: '160px' }}>Event Type</th>
                <th style={{ width: '120px' }}>Aggregate</th>
                <th style={{ width: '80px' }}>Attempts</th>
                <th>Last Error</th>
                <th style={{ width: '140px' }}>Failed At</th>
                <th style={{ width: '90px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>
                    <span className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                      {ev.event_type}
                    </span>
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    {ev.aggregate_type}
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '1px 5px',
                        borderRadius: '2px',
                        backgroundColor: 'rgba(219, 43, 43, 0.1)',
                        color: 'var(--color-danger)',
                        fontWeight: 600,
                      }}
                    >
                      {ev.attempts} / {ev.max_attempts}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontSize: '12px', color: 'var(--color-danger)', wordBreak: 'break-word' }}>
                      {ev.last_error || 'Unknown failure'}
                    </span>
                  </td>
                  <td style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                    {new Date(ev.updated_at).toLocaleString()}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => retryMutation.mutate(ev.id)}
                      disabled={retryingId === ev.id}
                      style={{ fontSize: '11px', padding: '2px 8px' }}
                    >
                      {retryingId === ev.id ? 'Retrying...' : 'Retry'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
