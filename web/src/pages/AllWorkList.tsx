import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

interface WorkItem {
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
  tags: string[];
}

interface ListResponse {
  items: WorkItem[];
  next_cursor?: string | null;
  has_more?: boolean;
  total_estimate?: number;
  pagination?: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    total?: number;
  };
}

interface Team {
  id: string;
  name: string;
  slug: string;
}

export const AllWorkList: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Extract filter parameters from URL
  const q = searchParams.get('q') || '';
  const status = searchParams.get('status') || '';
  const priority = searchParams.get('priority') || '';
  const type = searchParams.get('type') || '';
  const teamId = searchParams.get('team_id') || '';
  const assignee = searchParams.get('assignee') || '';
  const tag = searchParams.get('tag') || '';

  // Pagination cursor state
  const [accumulatedItems, setAccumulatedItems] = useState<WorkItem[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // Fetch available teams for filter dropdown
  const { data: teamsData } = useQuery<{ teams: Team[] }>({
    queryKey: ['teams'],
    queryFn: () => api.get<{ teams: Team[] }>('/teams'),
  });

  // Construct query string for current page
  const buildQueryString = (cursorVal?: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (type) params.set('type', type);
    if (teamId) params.set('team_id', teamId);
    if (assignee) params.set('assignee', assignee);
    if (tag) params.set('tag', tag);
    if (cursorVal) params.set('cursor', cursorVal);
    params.set('limit', '50');
    return params.toString();
  };

  // Fetch initial page whenever filters change
  const { data, isLoading, isFetching, error, refetch } = useQuery<ListResponse>({
    queryKey: ['items', q, status, priority, type, teamId, assignee, tag],
    queryFn: () => api.get<ListResponse>(`/items?${buildQueryString()}`),
  });

  // Reset accumulated items when filter parameters change
  useEffect(() => {
    if (data) {
      setAccumulatedItems(data.items);
      setCurrentCursor(data.next_cursor ?? data.pagination?.nextCursor ?? null);
      setHasNextPage(Boolean(data.has_more ?? data.pagination?.hasMore));
      setSelectedIndex(0);
    }
  }, [data]);

  const loadMoreItems = async () => {
    if (!currentCursor || isFetching) return;
    try {
      const res = await api.get<ListResponse>(`/items?${buildQueryString(currentCursor)}`);
      setAccumulatedItems((prev) => [...prev, ...res.items]);
      setCurrentCursor(res.next_cursor ?? res.pagination?.nextCursor ?? null);
      setHasNextPage(Boolean(res.has_more ?? res.pagination?.hasMore));
    } catch (err) {
      console.error('Failed to load more items:', err);
    }
  };

  // Keyboard navigation for j/k and Enter
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT';
      if (isInput) return;

      if (e.key === 'j') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, accumulatedItems.length - 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        const item = accumulatedItems[selectedIndex];
        if (item) {
          e.preventDefault();
          navigate(`/items/${item.id}`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [accumulatedItems, selectedIndex, navigate]);

  const updateFilter = (key: string, value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value) {
      nextParams.set(key, value);
    } else {
      nextParams.delete(key);
    }
    setSearchParams(nextParams);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', height: '100%' }}>
      {/* Filters Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          alignItems: 'center',
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', marginRight: '4px' }}>
          Filters:
        </span>

        {/* Status */}
        <select
          className="input"
          style={{ width: 'auto', padding: '3px 8px', fontSize: '12px' }}
          value={status}
          onChange={(e) => updateFilter('status', e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="new">New</option>
          <option value="triaged">Triaged</option>
          <option value="in_progress">In Progress</option>
          <option value="blocked">Blocked</option>
          <option value="awaiting_approval">Awaiting Approval</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>

        {/* Priority */}
        <select
          className="input"
          style={{ width: 'auto', padding: '3px 8px', fontSize: '12px' }}
          value={priority}
          onChange={(e) => updateFilter('priority', e.target.value)}
        >
          <option value="">All Priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        {/* Type */}
        <select
          className="input"
          style={{ width: 'auto', padding: '3px 8px', fontSize: '12px' }}
          value={type}
          onChange={(e) => updateFilter('type', e.target.value)}
        >
          <option value="">All Types</option>
          <option value="customer_issue">Customer Issue</option>
          <option value="engineering_problem">Engineering Problem</option>
          <option value="payment_investigation">Payment Investigation</option>
          <option value="production_incident">Production Incident</option>
          <option value="compliance_request">Compliance Request</option>
          <option value="operational_task">Operational Task</option>
        </select>

        {/* Team */}
        <select
          className="input"
          style={{ width: 'auto', padding: '3px 8px', fontSize: '12px' }}
          value={teamId}
          onChange={(e) => updateFilter('team_id', e.target.value)}
        >
          <option value="">All Teams</option>
          {teamsData?.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        {/* Assignee */}
        <select
          className="input"
          style={{ width: 'auto', padding: '3px 8px', fontSize: '12px' }}
          value={assignee}
          onChange={(e) => updateFilter('assignee', e.target.value)}
        >
          <option value="">All Assignees</option>
          <option value="me">Assigned to Me</option>
          <option value="unassigned">Unassigned</option>
        </select>

        {/* Clear Filters */}
        {(status || priority || type || teamId || assignee || tag || q) && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: '12px', padding: '3px 8px' }}
            onClick={() => setSearchParams(new URLSearchParams())}
          >
            Clear Filters
          </button>
        )}

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {data?.pagination?.total !== undefined
            ? `${accumulatedItems.length} of ${data.pagination.total.toLocaleString()}`
            : hasNextPage
            ? `${accumulatedItems.length} loaded, more available`
            : `${accumulatedItems.length} items`}
        </div>
      </div>

      {/* Main Table View */}
      <div
        style={{
          flex: 1,
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'auto',
        }}
      >
        {isLoading ? (
          <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="skeleton" style={{ height: '24px', width: '100%' }} />
            <div className="skeleton" style={{ height: '24px', width: '100%' }} />
            <div className="skeleton" style={{ height: '24px', width: '100%' }} />
          </div>
        ) : error ? (
          <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
            <p style={{ color: 'var(--color-danger)', fontSize: '13px' }}>
              Error loading items: {(error as any).message}
            </p>
            <button type="button" className="btn btn-secondary" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        ) : accumulatedItems.length === 0 ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
            <p style={{ fontSize: '14px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
              No work items match your selected filters.
            </p>
            {(status || priority || type || teamId || assignee || tag || q) && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '12px' }}
                onClick={() => setSearchParams(new URLSearchParams())}
              >
                Reset All Filters
              </button>
            )}
          </div>
        ) : (
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ width: '90px', textAlign: 'left', whiteSpace: 'nowrap' }}>Ref</th>
                <th style={{ width: '120px', textAlign: 'left' }}>Status</th>
                <th style={{ width: '90px', textAlign: 'left' }}>Priority</th>
                <th style={{ textAlign: 'left' }}>Title</th>
                <th style={{ width: '120px', textAlign: 'left' }}>Team</th>
                <th style={{ width: '130px', textAlign: 'left' }}>Assignee</th>
                <th style={{ width: '120px', textAlign: 'left' }}>Due / Updated</th>
              </tr>
            </thead>
            <tbody>
              {accumulatedItems.map((item, index) => {
                const isSelected = index === selectedIndex;
                const isOverdue = Boolean(
                  item.due_at &&
                  item.status !== 'resolved' &&
                  item.status !== 'closed' &&
                  new Date(item.due_at).getTime() < Date.now()
                );

                return (
                  <tr
                    key={item.id}
                    onClick={() => {
                      setSelectedIndex(index);
                      navigate(`/items/${item.id}`);
                    }}
                    style={{
                      cursor: 'pointer',
                      backgroundColor: isSelected ? 'var(--color-accent-subtle)' : undefined,
                    }}
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: '12px', whiteSpace: 'nowrap' }}>
                        {item.short_ref}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-status-${item.status}`}>
                        {item.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-priority-${item.priority}`}>
                        {item.priority}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
                          {item.title}
                        </span>
                        {isOverdue && (
                          <span className="badge-overdue" title={`Overdue since ${new Date(item.due_at!).toLocaleDateString()}`}>
                            ⚠️ Overdue
                          </span>
                        )}
                        {item.tags?.map((t) => (
                          <span
                            key={t}
                            style={{
                              fontSize: '10px',
                              padding: '0 4px',
                              borderRadius: '2px',
                              backgroundColor: 'var(--color-bg-subtle)',
                              color: 'var(--color-text-muted)',
                            }}
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>
                      {item.team_name}
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>
                      {item.assignee_name || (
                        <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td style={{ color: 'var(--color-text-muted)', fontSize: '11px', whiteSpace: 'nowrap' }}>
                      {isOverdue && item.due_at ? (
                        <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                          Due: {new Date(item.due_at).toLocaleDateString()}
                        </span>
                      ) : item.due_at ? (
                        <span>
                          Due: {new Date(item.due_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span>
                          {new Date(item.last_activity_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination Footer */}
      {hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={loadMoreItems}
            disabled={isFetching}
            style={{ fontSize: '13px', padding: '6px 16px' }}
          >
            {isFetching ? 'Loading more items...' : 'Load More Work Items'}
          </button>
        </div>
      )}
    </div>
  );
};
