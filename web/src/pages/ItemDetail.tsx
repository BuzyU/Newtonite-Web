import React, { useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAuth } from '../AuthContext';
import { useIdempotencyKey } from '../useIdempotencyKey';

interface ItemDetailData {
  item: {
    id: string;
    short_ref: string;
    team_id: string;
    team_name: string;
    type: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    reporter_id: string;
    reporter_name: string;
    assignee_id: string | null;
    assignee_name: string | null;
    due_at: string | null;
    requires_approval: boolean;
    approval_status: string;
    approved_by: string | null;
    approved_by_name: string | null;
    resolution_note: string | null;
    tags: string[];
    version: number;
    created_at: string;
    updated_at: string;
    last_activity_at: string;
    closed_at: string | null;
    archived_at: string | null;
  };
  comments: Array<{
    id: string;
    user_id: string;
    user_name: string;
    content: string;
    created_at: string;
  }>;
  activity: Array<{
    id: string;
    actor_id: string;
    actor_name: string;
    action: string;
    old_values: any;
    new_values: any;
    note: string | null;
    created_at: string;
  }>;
  computed_next: string;
  permissions: {
    can_edit: boolean;
    can_claim: boolean;
    can_change_status: boolean;
    can_comment: boolean;
    can_approve: boolean;
  };
}

export const ItemDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Edit form state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState('');

  // Transition note modal/dialog state
  const [actionModal, setActionModal] = useState<{
    action: string;
    targetStatus?: string;
    title: string;
    noteRequired: boolean;
  } | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Stale version conflict state (412 STALE_VERSION)
  const [staleConflict, setStaleConflict] = useState<{
    serverItem: any;
    userChanges: any;
    message: string;
  } | null>(null);

  // Claim error state (409 ALREADY_CLAIMED)
  const [claimError, setClaimError] = useState<string | null>(null);
  const isClaimingRef = useRef(false);

  // Saving / saved / failed feedback state
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  // New comment state
  const [newComment, setNewComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);

  // Keyset activity pagination
  const [activityItems, setActivityItems] = useState<any[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const [isLoadingMoreActivity, setIsLoadingMoreActivity] = useState(false);

  // Fetch full item detail
  const { data, isLoading, error, refetch } = useQuery<ItemDetailData>({
    queryKey: ['item', id],
    queryFn: async () => {
      const res = await api.get<ItemDetailData>(`/items/${id}`);
      // Initialize edit fields and activity state
      setEditTitle(res.item.title);
      setEditDescription(res.item.description);
      setEditPriority(res.item.priority);
      const activity = res.activity || [];
      setActivityItems(activity);
      if (activity.length > 0) {
        setActivityCursor(activity[activity.length - 1].id);
        setHasMoreActivity(activity.length >= 20);
      }
      return res;
    },
    enabled: !!id,
  });

  const item = data?.item;

  // Idempotency keys per user intent
  const { key: updateKey, reset: resetUpdateKey } = useIdempotencyKey('update');
  const { key: claimKey, reset: resetClaimKey } = useIdempotencyKey('claim');
  const { key: transitionKey, reset: resetTransitionKey } = useIdempotencyKey('transition');
  const { key: commentKey, reset: resetCommentKey } = useIdempotencyKey('comment');

  // Mutation for updating item with optimistic concurrency (If-Match)
  const updateMutation = useMutation({
    mutationFn: ({ changes, version }: { changes: any; version: number }) => {
      setSaveStatus('saving');
      setActionError(null);
      return api.patch(`/items/${id}`, changes, {
        headers: {
          'If-Match': `"${version}"`,
        },
        idempotencyKey: updateKey,
        maxRetries: 1, // Safe to retry once on 503 since idempotency key guarantees exactly-once server execution
      });
    },
    onSuccess: () => {
      resetUpdateKey();
      setIsEditing(false);
      setSaveStatus('saved');
      setStaleConflict(null);
      setTimeout(() => setSaveStatus('idle'), 3000);
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: (err: any) => {
      setSaveStatus('failed');
      if (err instanceof ApiError && err.status === 412) {
        // Concurrency conflict! Server returned current version
        setStaleConflict({
          serverItem: err.details?.current_item || null,
          userChanges: { title: editTitle, description: editDescription, priority: editPriority },
          message: err.message || 'This item was updated by another team member while you were editing.',
        });
      } else {
        setActionError(err.message || 'Failed to save changes');
      }
    },
  });

  // Mutation for atomic claim
  const claimMutation = useMutation({
    mutationFn: () =>
      api.post(
        `/items/${id}/claim`,
        {},
        {
          idempotencyKey: claimKey,
          maxRetries: 1,
        }
      ),
    onSuccess: () => {
      resetClaimKey();
      setClaimError(null);
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError && err.code === 'ALREADY_CLAIMED') {
        const owner = err.error?.current_assignee?.name || err.error?.currentAssignee?.name || err.details?.current_assignee?.name || 'another team member';
        setClaimError(`Already claimed by ${owner}.`);
      } else {
        setClaimError(err.message || 'Claim failed');
      }
      queryClient.invalidateQueries({ queryKey: ['item', id] });
    },
  });

  // Mutation for state transitions
  const transitionMutation = useMutation({
    mutationFn: ({ targetStatus, action, note }: { targetStatus?: string; action?: string; note?: string }) => {
      setActionError(null);
      const headers = item?.version ? { 'If-Match': `"${item.version}"` } : undefined;
      const opts = {
        headers,
        idempotencyKey: transitionKey,
        maxRetries: 1,
      };
      if (action === 'approve') {
        return api.post(`/items/${id}/approve`, { note }, opts);
      }
      if (action === 'reject') {
        return api.post(`/items/${id}/reject`, { note }, opts);
      }
      if (action === 'reopen') {
        return api.post(`/items/${id}/reopen`, { note }, opts);
      }
      return api.post(`/items/${id}/transition`, { status: targetStatus, note }, opts);
    },
    onSuccess: () => {
      resetTransitionKey();
      setActionModal(null);
      setActionNote('');
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError && err.status === 412) {
        setStaleConflict({
          serverItem: err.details?.current_item || null,
          userChanges: null,
          message: err.message || 'Item was updated by another operator. Please reload.',
        });
      } else {
        setActionError(err.message || 'Transition failed');
      }
    },
  });

  // Mutation for comments
  const commentMutation = useMutation({
    mutationFn: (content: string) =>
      api.post(
        `/items/${id}/comments`,
        { content },
        {
          idempotencyKey: commentKey,
          maxRetries: 1,
        }
      ),
    onSuccess: () => {
      resetCommentKey();
      setNewComment('');
      setCommentError(null);
      queryClient.invalidateQueries({ queryKey: ['item', id] });
    },
    onError: (err: any) => {
      setCommentError(err.message || 'Failed to post comment');
    },
  });

  // Load more activity items using keyset cursor
  const loadMoreActivity = async () => {
    if (!activityCursor || isLoadingMoreActivity) return;
    setIsLoadingMoreActivity(true);
    try {
      const res = await api.get<{ activity: any[]; has_more: boolean }>(
        `/items/${id}/activity?cursor=${activityCursor}&limit=20`
      );
      const activity = res.activity || [];
      setActivityItems((prev) => [...prev, ...activity]);
      setHasMoreActivity(res.has_more ?? false);
      if (activity.length > 0) {
        setActivityCursor(activity[activity.length - 1].id);
      }
    } catch (err) {
      console.error('Failed to load more activity:', err);
    } finally {
      setIsLoadingMoreActivity(false);
    }
  };

  if (isLoading) {
    return (
      <div style={{ maxWidth: '960px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="skeleton" style={{ height: '36px', width: '300px' }} />
        <div className="skeleton" style={{ height: '120px', width: '100%' }} />
        <div className="skeleton" style={{ height: '300px', width: '100%' }} />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div style={{ maxWidth: '600px', margin: '40px auto', textAlign: 'center' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-danger)' }}>
          Work item not found or access denied
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '8px' }}>
          {(error as any)?.message || 'You may not belong to the team this item belongs to.'}
        </p>
        <Link to="/work" className="btn btn-secondary" style={{ marginTop: '16px' }}>
          Back to All Work
        </Link>
      </div>
    );
  }

  const isAssigneeMe = item.assignee_id === user?.id;

  return (
    <div style={{ maxWidth: '1040px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Back Link */}
      <div>
        <Link
          to="/work"
          style={{ fontSize: '12px', color: 'var(--color-text-secondary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          ← Back to All Work
        </Link>
      </div>

      {/* Inline Action Error Banner */}
      {actionError && (
        <div
          role="alert"
          aria-live="assertive"
          id="item-action-error-banner"
          style={{
            padding: '10px 14px',
            backgroundColor: 'var(--color-danger-bg)',
            border: '1px solid var(--color-danger)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-danger)',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setActionError(null)}
            style={{ fontSize: '12px', padding: '2px 8px' }}
          >
            ✕ Dismiss
          </button>
        </div>
      )}

      {/* STALE VERSION CONFLICT RESOLUTION PANEL (Section 5.2 / Section 10) */}
      {staleConflict && (
        <div
          id="stale-conflict-panel"
          role="alert"
          aria-live="assertive"
          style={{
            backgroundColor: 'var(--color-warning-bg)',
            border: '1px solid var(--color-warning-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-4)',
            color: 'var(--color-warning-text)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontWeight: 600, fontSize: '14px' }}>⚠ Concurrency Conflict (Stale Version)</span>
            <span style={{ fontSize: '12px' }}>
              Another team member updated this item before your changes were saved.
            </span>
          </div>

          <p style={{ fontSize: '13px', margin: '0 0 12px 0' }}>{staleConflict.message}</p>

          {staleConflict.serverItem && (
            <div
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.7)',
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '12px',
                marginBottom: '12px',
                border: '1px solid #e0c27b',
              }}
            >
              <div>
                <strong>Current Server Title:</strong> {staleConflict.serverItem.title}
              </div>
              <div>
                <strong>Current Server Priority:</strong> {staleConflict.serverItem.priority}
              </div>
              <div>
                <strong>Current Version:</strong> v{staleConflict.serverItem.version}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setStaleConflict(null);
                refetch();
              }}
              style={{ fontSize: '12px' }}
            >
              Discard my edits & load latest
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const targetVer = staleConflict.serverItem?.version ?? item.version;
                updateMutation.mutate({
                  changes: {
                    title: editTitle,
                    description: editDescription,
                    priority: editPriority,
                  },
                  version: targetVer,
                });
              }}
              disabled={updateMutation.isPending}
              style={{ fontSize: '12px' }}
            >
              Re-apply my edits to latest (v{staleConflict.serverItem?.version ?? item.version})
            </button>
          </div>
        </div>
      )}

      {/* Main Item Header Card */}
      <div
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span className="mono" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {item.short_ref}
              </span>
              <span className={`badge badge-status-${item.status}`}>
                {item.status.replace('_', ' ')}
              </span>
              <span className={`badge badge-priority-${item.priority}`}>
                {item.priority}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                v{item.version}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginLeft: '4px' }}>
                • {item.team_name}
              </span>
            </div>

            {!isEditing ? (
              <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
                {item.title}
              </h1>
            ) : (
              <input
                type="text"
                className="input"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                style={{ fontSize: '18px', fontWeight: 600 }}
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {saveStatus === 'saving' && (
              <span className="mono" style={{ fontSize: '11px', color: 'var(--color-accent)' }}>● Saving...</span>
            )}
            {saveStatus === 'saved' && (
              <span className="mono" style={{ fontSize: '11px', color: 'var(--color-success)' }}>✓ Saved</span>
            )}
            {saveStatus === 'failed' && (
              <span className="mono" style={{ fontSize: '11px', color: 'var(--color-danger)' }}>✕ Save failed</span>
            )}

            {!isEditing ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setIsEditing(true)}
                style={{ fontSize: '12px', padding: '4px 10px' }}
              >
                Edit Details
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setIsEditing(false);
                    setEditTitle(item.title);
                    setEditDescription(item.description);
                    setEditPriority(item.priority);
                  }}
                  style={{ fontSize: '12px' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    updateMutation.mutate({
                      changes: { title: editTitle, description: editDescription, priority: editPriority },
                      version: item.version,
                    })
                  }
                  disabled={updateMutation.isPending}
                  style={{ fontSize: '12px' }}
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Computed "Next" line */}
        <div
          style={{
            marginTop: 'var(--space-3)',
            padding: '6px 10px',
            backgroundColor: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Next:</span>
          <span>{data.computed_next}</span>
        </div>

        {/* Claim Bar / Assignee info */}
        <div
          style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>Assignee:</span>
            <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
              {item.assignee_name || 'Nobody owns this yet'}
            </span>
            {item.assignee_id && isAssigneeMe && (
              <span style={{ fontSize: '11px', color: 'var(--color-accent)', fontWeight: 500 }}>(You)</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {claimError && (
              <span role="alert" aria-live="assertive" id="claim-error-text" style={{ fontSize: '12px', color: 'var(--color-danger)', fontWeight: 600 }}>{claimError}</span>
            )}
            {!item.assignee_id && item.status !== 'closed' && (
              <button
                type="button"
                className="btn btn-primary"
                id="claim-action-btn"
                onClick={() => {
                  if (claimMutation.isPending || isClaimingRef.current) return;
                  isClaimingRef.current = true;
                  claimMutation.mutate(undefined, {
                    onSettled: () => {
                      isClaimingRef.current = false;
                    },
                  });
                }}
                disabled={claimMutation.isPending}
                style={{ fontSize: '12px' }}
              >
                {claimMutation.isPending ? 'Claiming...' : 'Claim This Item'}
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <div
            style={{
              marginTop: 'var(--space-3)',
              padding: '8px 12px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderLeft: '3px solid var(--color-danger)',
              color: 'var(--color-danger)',
              fontSize: '12px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: '14px' }}
            >
              ×
            </button>
          </div>
        )}

        {/* State Machine Transition Action Bar */}
        <div
          style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', marginRight: '4px' }}>
            Workflow Actions:
          </span>

          {item.status === 'new' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setActionError(null);
                transitionMutation.mutate({ targetStatus: 'triaged' });
              }}
              disabled={transitionMutation.isPending}
              style={{ fontSize: '12px' }}
            >
              Mark Triaged
            </button>
          )}

          {item.status === 'triaged' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!item.assignee_id) {
                  setActionError('Item must have an assignee before moving to In Progress. Please claim it first.');
                  return;
                }
                setActionError(null);
                transitionMutation.mutate({ targetStatus: 'in_progress' });
              }}
              disabled={transitionMutation.isPending}
              style={{ fontSize: '12px' }}
            >
              Start Progress
            </button>
          )}

          {item.status === 'in_progress' && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => transitionMutation.mutate({ targetStatus: 'blocked' })}
                disabled={transitionMutation.isPending}
                style={{ fontSize: '12px' }}
              >
                Mark Blocked
              </button>

              {item.requires_approval ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => transitionMutation.mutate({ targetStatus: 'awaiting_approval' })}
                  disabled={transitionMutation.isPending}
                  style={{ fontSize: '12px' }}
                >
                  Submit for Lead Approval
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    setActionModal({
                      action: 'resolve',
                      targetStatus: 'resolved',
                      title: 'Resolve Item',
                      noteRequired: true,
                    })
                  }
                  style={{ fontSize: '12px' }}
                >
                  Resolve
                </button>
              )}
            </>
          )}

          {item.status === 'blocked' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => transitionMutation.mutate({ targetStatus: 'in_progress' })}
              disabled={transitionMutation.isPending}
              style={{ fontSize: '12px' }}
            >
              Unblock
            </button>
          )}

          {item.status === 'awaiting_approval' && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  setActionModal({
                    action: 'approve',
                    title: 'Approve and Resolve Item',
                    noteRequired: true,
                  })
                }
                style={{ fontSize: '12px' }}
              >
                Approve & Resolve
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  setActionModal({
                    action: 'reject',
                    title: 'Reject to In Progress',
                    noteRequired: true,
                  })
                }
                style={{ fontSize: '12px' }}
              >
                Reject
              </button>
            </>
          )}

          {item.status === 'resolved' && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => transitionMutation.mutate({ targetStatus: 'closed' })}
                disabled={transitionMutation.isPending}
                style={{ fontSize: '12px' }}
              >
                Close Item
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  setActionModal({
                    action: 'reopen',
                    title: 'Reopen Item to Triaged',
                    noteRequired: true,
                  })
                }
                style={{ fontSize: '12px' }}
              >
                Reopen
              </button>
            </>
          )}

          {item.status === 'closed' && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                setActionModal({
                  action: 'reopen',
                  title: 'Reopen Item to Triaged',
                  noteRequired: true,
                })
              }
              style={{ fontSize: '12px' }}
            >
              Reopen Item
            </button>
          )}
        </div>
      </div>

      {/* Two Column Grid: Details & Properties */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-6)' }}>
        {/* Left Column: Description, Activity Timeline, Comments */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {/* Reason It Exists (Description) */}
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-6)',
            }}
          >
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
              Why This Exists
            </h2>
            {!isEditing ? (
              <p style={{ fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--color-text-primary)', margin: 0 }}>
                {item.description}
              </p>
            ) : (
              <textarea
                className="input"
                rows={5}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                style={{ fontSize: '14px', lineHeight: 1.5 }}
              />
            )}

            {item.resolution_note && (
              <div
                style={{
                  marginTop: 'var(--space-4)',
                  padding: '10px 12px',
                  backgroundColor: 'rgba(24, 121, 78, 0.08)',
                  borderLeft: '3px solid var(--color-success)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-success)', marginBottom: '2px' }}>
                  Resolution Note
                </div>
                <div style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
                  {item.resolution_note}
                </div>
              </div>
            )}
          </div>

          {/* Activity Log Timeline (Keyset paginated) */}
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-6)',
            }}
          >
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 'var(--space-4)' }}>
              Activity History
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {activityItems.map((act) => (
                <div
                  key={act.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    paddingBottom: '8px',
                    borderBottom: '1px solid var(--color-border-subtle)',
                    fontSize: '13px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
                      {act.actor_name || 'System'}{' '}
                      <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>
                        {act.action === 'created'
                          ? 'created this item'
                          : act.action === 'claimed'
                          ? 'claimed this item'
                          : act.action === 'status_changed'
                          ? `changed status from ${act.old_values?.status} to ${act.new_values?.status}`
                          : act.action === 'assigned'
                          ? `assigned to ${act.new_values?.assignee_name || 'user'}`
                          : act.action === 'updated'
                          ? 'updated properties'
                          : act.action === 'approved'
                          ? 'approved this item'
                          : act.action === 'rejected'
                          ? 'rejected this item'
                          : act.action === 'reopened'
                          ? 'reopened this item'
                          : act.action}
                      </span>
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                      {new Date(act.created_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {act.note && (
                    <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', fontStyle: 'italic', paddingLeft: '8px' }}>
                      Note: "{act.note}"
                    </div>
                  )}
                </div>
              ))}
            </div>

            {hasMoreActivity && (
              <div style={{ marginTop: 'var(--space-3)', textAlign: 'center' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={loadMoreActivity}
                  disabled={isLoadingMoreActivity}
                  style={{ fontSize: '12px' }}
                >
                  {isLoadingMoreActivity ? 'Loading...' : 'Load older activity'}
                </button>
              </div>
            )}
          </div>

          {/* Comments Section */}
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-6)',
            }}
          >
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 'var(--space-4)' }}>
              Comments ({(data?.comments || []).length})
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
              {(data?.comments || []).map((c) => (
                <div
                  key={c.id}
                  style={{
                    padding: '10px 12px',
                    backgroundColor: 'var(--color-bg-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      {c.user_name}
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                      {new Date(c.created_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap' }}>
                    {c.content}
                  </div>
                </div>
              ))}
            </div>

            {commentError && (
              <div style={{ fontSize: '12px', color: 'var(--color-danger)', marginBottom: '8px' }}>
                {commentError}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newComment.trim()) {
                  commentMutation.mutate(newComment.trim());
                }
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <textarea
                className="input"
                rows={3}
                placeholder="Leave a comment (supports @mentions, e.g. @priya)..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={commentMutation.isPending || !newComment.trim()}
                  style={{ fontSize: '12px' }}
                >
                  {commentMutation.isPending ? 'Posting...' : 'Post Comment'}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Compact Properties Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-4)',
            }}
          >
            <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 'var(--space-3)' }}>
              Properties
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: '12px' }}>
              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Type</span>
                <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  {item.type ? item.type.replace('_', ' ') : 'task'}
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Priority</span>
                {!isEditing ? (
                  <span className={`badge badge-priority-${item.priority}`}>{item.priority}</span>
                ) : (
                  <select
                    className="input"
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    style={{ fontSize: '12px', padding: '2px 6px' }}
                  >
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                )}
              </div>

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Reporter</span>
                <span style={{ color: 'var(--color-text-primary)' }}>{item.reporter_name}</span>
              </div>

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Due Date</span>
                <span style={{ color: 'var(--color-text-primary)' }}>
                  {item.due_at ? new Date(item.due_at).toLocaleDateString() : 'None set'}
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Requires Lead Approval</span>
                <span style={{ color: 'var(--color-text-primary)' }}>
                  {item.requires_approval ? 'Yes (Mandatory)' : 'No'}
                </span>
              </div>

              {item.requires_approval && (
                <div>
                  <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Approval Status</span>
                  <span style={{ color: 'var(--color-text-primary)', textTransform: 'capitalize' }}>
                    {item.approval_status}
                  </span>
                </div>
              )}

              {item.approved_by_name && (
                <div>
                  <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Approved By</span>
                  <span style={{ color: 'var(--color-text-primary)' }}>{item.approved_by_name}</span>
                </div>
              )}

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Created</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {new Date(item.created_at).toLocaleDateString()}
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--color-text-muted)', display: 'block' }}>Tags</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                  {(item.tags && item.tags.length > 0) ? (
                    item.tags.map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          backgroundColor: 'var(--color-bg-subtle)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        #{t}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>None</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal for Transition Action with Note */}
      {actionModal && (
        <div className="modalBackdrop" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ backgroundColor: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-6)', width: '100%', maxWidth: '480px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>
              {actionModal.title}
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
              {actionModal.noteRequired ? 'A note is required for this action.' : 'Add an optional note.'}
            </p>

            <textarea
              className="input"
              rows={3}
              placeholder="Provide reason or context for this decision..."
              value={actionNote}
              onChange={(e) => {
                setActionNote(e.target.value);
                if (modalError) setModalError(null);
              }}
              required={actionModal.noteRequired}
            />

            {modalError && (
              <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '6px' }}>
                {modalError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setActionModal(null);
                  setModalError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (actionModal.noteRequired && !actionNote.trim()) {
                    setModalError('Please enter a note explaining this decision.');
                    return;
                  }
                  setModalError(null);
                  transitionMutation.mutate({
                    action: actionModal.action,
                    targetStatus: actionModal.targetStatus,
                    note: actionNote.trim(),
                  });
                }}
                disabled={transitionMutation.isPending}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
