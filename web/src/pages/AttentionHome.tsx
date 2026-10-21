import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

interface AttentionItem {
  id: string;
  short_ref: string;
  team_id: string;
  team_name: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due_at: string | null;
  last_activity_at: string;
  days_quiet?: number;
  latest_comment?: string;
  commenter_name?: string;
}

interface AttentionData {
  awaiting_approval: AttentionItem[];
  mine_due_soon: AttentionItem[];
  urgent_unassigned: AttentionItem[];
  mentions: AttentionItem[];
  gone_quiet: AttentionItem[];
}

export const AttentionHome: React.FC = () => {
  const queryClient = useQueryClient();
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});

  const { data, isLoading, error, refetch } = useQuery<AttentionData>({
    queryKey: ['attention'],
    queryFn: () => api.get<AttentionData>('/attention'),
  });

  const claimMutation = useMutation({
    mutationFn: (itemId: string) => api.post(`/items/${itemId}/claim`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attention'] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
    onError: (err: any, itemId: string) => {
      if (err instanceof ApiError && err.code === 'ALREADY_CLAIMED') {
        const owner = err.details?.current_assignee?.name || 'another user';
        setClaimErrors((prev) => ({ ...prev, [itemId]: `Already claimed by ${owner}` }));
      } else {
        setClaimErrors((prev) => ({ ...prev, [itemId]: err.message || 'Claim failed' }));
      }
      queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
  });

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="skeleton" style={{ height: '32px', width: '200px' }} />
        <div className="skeleton" style={{ height: '140px', width: '100%' }} />
        <div className="skeleton" style={{ height: '140px', width: '100%' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-danger)', fontSize: '14px', marginBottom: 'var(--space-3)' }}>
          Failed to load your attention queue: {(error as any).message}
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const awaiting = data?.awaiting_approval || [];
  const dueSoon = data?.mine_due_soon || [];
  const urgentUnassigned = data?.urgent_unassigned || [];
  const mentions = data?.mentions || [];
  const goneQuiet = data?.gone_quiet || [];

  const totalCount = awaiting.length + dueSoon.length + urgentUnassigned.length + mentions.length + goneQuiet.length;

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
            My Attention
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '2px', marginBottom: 0 }}>
            {totalCount === 0
              ? 'Nothing urgently requires your attention. You are all caught up.'
              : `${totalCount} item${totalCount === 1 ? '' : 's'} need triage, approval, or follow-up.`}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => refetch()} style={{ fontSize: '12px' }}>
          ↻ Refresh
        </button>
      </div>

      {/* Section 1: Urgent & Unassigned */}
      {urgentUnassigned.length > 0 && (
        <section
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              backgroundColor: 'rgba(219, 43, 43, 0.06)',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-danger)' }}>
                Urgent & Unassigned ({urgentUnassigned.length})
              </span>
              <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                Items requiring immediate team triage
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {urgentUnassigned.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {item.short_ref}
                  </span>
                  <span className="badge badge-priority-urgent">Urgent</span>
                  <Link
                    to={`/items/${item.id}`}
                    style={{
                      fontWeight: 500,
                      color: 'var(--color-text-primary)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.title}
                  </Link>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{item.team_name}</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  {claimErrors[item.id] ? (
                    <span role="alert" aria-live="assertive" style={{ fontSize: '12px', color: 'var(--color-danger)', fontWeight: 600 }}>{claimErrors[item.id]}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: '12px', padding: '3px 8px' }}
                      disabled={claimMutation.isPending}
                      onClick={() => claimMutation.mutate(item.id)}
                    >
                      Claim
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 2: Awaiting My Approval */}
      {awaiting.length > 0 && (
        <section
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              backgroundColor: 'rgba(217, 119, 6, 0.06)',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-warning)' }}>
              Awaiting Lead Approval ({awaiting.length})
            </span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              Pending your review as team lead
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {awaiting.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                    {item.short_ref}
                  </span>
                  <Link
                    to={`/items/${item.id}`}
                    style={{
                      fontWeight: 500,
                      color: 'var(--color-text-primary)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.title}
                  </Link>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                    Assigned: {item.assignee_name || 'Unassigned'}
                  </span>
                </div>

                <Link to={`/items/${item.id}`} className="btn btn-secondary" style={{ fontSize: '12px', padding: '3px 8px' }}>
                  Review
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 3: Assigned to Me - Overdue or Due Soon */}
      {dueSoon.length > 0 && (
        <section
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Due Soon or Overdue ({dueSoon.length})
            </span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              Assigned to you
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {dueSoon.map((item) => {
              const isOverdue = item.due_at && new Date(item.due_at) < new Date();
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 16px',
                    borderBottom: '1px solid var(--color-border-subtle)',
                    fontSize: '13px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                      {item.short_ref}
                    </span>
                    <span className={`badge badge-status-${item.status}`}>{item.status.replace('_', ' ')}</span>
                    <Link
                      to={`/items/${item.id}`}
                      style={{
                        fontWeight: 500,
                        color: 'var(--color-text-primary)',
                        textDecoration: 'none',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </Link>
                  </div>

                  <span
                    style={{
                      fontSize: '12px',
                      color: isOverdue ? 'var(--color-danger)' : 'var(--color-warning)',
                      fontWeight: isOverdue ? 600 : 400,
                    }}
                  >
                    {isOverdue ? 'Overdue: ' : 'Due: '}
                    {item.due_at ? new Date(item.due_at).toLocaleDateString() : 'N/A'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Section 4: Mentions with No Reply */}
      {mentions.length > 0 && (
        <section
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Recent Mentions ({mentions.length})
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {mentions.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                    {item.short_ref}
                  </span>
                  <Link to={`/items/${item.id}`} style={{ fontWeight: 500, color: 'var(--color-text-primary)', textDecoration: 'none' }}>
                    {item.title}
                  </Link>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                    by {item.commenter_name}
                  </span>
                </div>
                {item.latest_comment && (
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                    "{item.latest_comment}"
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 5: Gone Quiet */}
      {goneQuiet.length > 0 && (
        <section
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Gone Quiet ({goneQuiet.length})
            </span>
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              No updates in 3+ days
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {goneQuiet.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 16px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                    {item.short_ref}
                  </span>
                  <span className={`badge badge-status-${item.status}`}>{item.status.replace('_', ' ')}</span>
                  <Link
                    to={`/items/${item.id}`}
                    style={{
                      fontWeight: 500,
                      color: 'var(--color-text-primary)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.title}
                  </Link>
                </div>

                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  Inactive for {item.days_quiet || 3} days
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {totalCount === 0 && (
        <div
          style={{
            padding: 'var(--space-8)',
            textAlign: 'center',
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
            All Caught Up
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
            There are no urgent items, pending approvals, or overdue tasks in your queues right now.
          </p>
        </div>
      )}
    </div>
  );
};
