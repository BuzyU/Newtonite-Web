import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import styles from './Layout.module.css';

interface Team {
  id: string;
  name: string;
  slug: string;
  my_role?: string | null;
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface CreateItemModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateItemModal: React.FC<CreateItemModalProps> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [teamId, setTeamId] = useState<string>('');
  const [type, setType] = useState<string>('customer_issue');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [dueAt, setDueAt] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [tagsInput, setTagsInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch teams available to the user
  const { data: teamsData } = useQuery<{ teams: Team[] }>({
    queryKey: ['teams'],
    queryFn: () => api.get<{ teams: Team[] }>('/teams'),
    enabled: isOpen,
  });

  const teams = teamsData?.teams || [];

  // Automatically select the first team if not selected yet
  React.useEffect(() => {
    if (teams.length > 0 && !teamId) {
      setTeamId(teams[0].id);
    }
  }, [teams, teamId]);

  // Fetch team members when teamId is selected
  const { data: teamDetail } = useQuery<{ team: Team; members: TeamMember[] }>({
    queryKey: ['team', teamId],
    queryFn: () => api.get<{ team: Team; members: TeamMember[] }>(`/teams/${teamId}`),
    enabled: isOpen && !!teamId,
  });

  const members = teamDetail?.members || [];

  const createMutation = useMutation<{ item: { id: string; short_ref: string } }, any, any>({
    mutationFn: (payload: any) => api.post<{ item: { id: string; short_ref: string } }>('/items', payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['attention'] });
      onClose();
      // Reset form
      setTitle('');
      setDescription('');
      setTagsInput('');
      setAssigneeId('');
      setDueAt('');
      setRequiresApproval(false);
      setErrorMsg(null);
      navigate(`/items/${res.item.id}`);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || 'Failed to create work item');
    },
  });

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!teamId) {
      setErrorMsg('Please select a team');
      return;
    }
    if (!title.trim() || title.trim().length < 3) {
      setErrorMsg('Title must be at least 3 characters');
      return;
    }
    if (!description.trim()) {
      setErrorMsg('Description is required');
      return;
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    createMutation.mutate({
      teamId,
      type,
      title: title.trim(),
      description: description.trim(),
      priority,
      assigneeId: assigneeId || null,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      requiresApproval,
      tags,
    });
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="Create Work Item">
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()} style={{ padding: 'var(--space-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 600 }}>Create New Work Item</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: '2px 6px' }}>
            Esc
          </button>
        </div>

        {errorMsg && (
          <div style={{ padding: '8px 12px', background: 'var(--color-bg-subtle)', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', borderRadius: 'var(--radius-sm)', fontSize: '13px', marginBottom: 'var(--space-4)' }}>
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Team *
              </label>
              <select
                id="create-item-team-select"
                className="input"
                value={teamId}
                onChange={(e) => {
                  setTeamId(e.target.value);
                  setAssigneeId('');
                }}
                required
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.my_role ? `(${t.my_role})` : user?.is_org_admin ? '(admin)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Item Type *
              </label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="customer_issue">Customer Issue</option>
                <option value="engineering_problem">Engineering Problem</option>
                <option value="payment_investigation">Payment Investigation</option>
                <option value="production_incident">Production Incident</option>
                <option value="compliance_request">Compliance Request</option>
                <option value="operational_task">Operational Task</option>
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
              Title *
            </label>
            <input
              type="text"
              id="create-item-title"
              className="input"
              placeholder="e.g. Stripe webhook timeout on reconciliation"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
              maxLength={200}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
              Description (Why it exists) *
            </label>
            <textarea
              className="input"
              rows={4}
              placeholder="Provide background context, impact, and expected resolution..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              maxLength={5000}
              style={{ resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Priority
              </label>
              <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Assignee
              </label>
              <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Due Date
              </label>
              <input
                type="datetime-local"
                className="input"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                Tags (comma separated)
              </label>
              <input
                type="text"
                className="input"
                placeholder="database, billing, tier-1"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
            <input
              type="checkbox"
              id="requires_approval"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <label htmlFor="requires_approval" style={{ fontSize: '13px', cursor: 'pointer', color: 'var(--color-text-primary)' }}>
              Requires Lead Approval before resolving
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-subtle)', paddingTop: 'var(--space-4)' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={createMutation.isPending}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
