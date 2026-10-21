import React, { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { apiFetch } from '../api';
import { Link, Navigate } from 'react-router-dom';

interface OrgUser {
  id: string;
  email: string;
  name: string;
  isOrgAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  teams: Array<{
    teamId: string;
    teamName: string;
    teamSlug: string;
    role: string;
  }>;
}

interface TeamOption {
  id: string;
  name: string;
  slug: string;
  prefix: string;
}

export const AdminDashboard: React.FC = () => {
  const { user } = useAuth();

  const [users, setUsers] = useState<OrgUser[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [selectedRole, setSelectedRole] = useState<'member' | 'lead' | 'viewer' | 'admin'>('member');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Generated Credentials Display
  const [createdCredentials, setCreatedCredentials] = useState<{
    email: string;
    password: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Guard: Only organization admins can view this page
  if (user && !user.is_org_admin && !user.isOrgAdmin) {
    return <Navigate to="/" replace />;
  }

  const loadData = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [usersRes, teamsRes] = await Promise.all([
        apiFetch<{ users: OrgUser[] }>('/api/v1/admin/users'),
        apiFetch<{ teams: TeamOption[] }>('/api/v1/teams'),
      ]);
      setUsers(usersRes.data.users);
      setTeams(teamsRes.data.teams);
      if (teamsRes.data.teams.length > 0 && !selectedTeamId) {
        setSelectedTeamId(teamsRes.data.teams[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load organization members.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserName.trim() || !newUserEmail.trim()) {
      setErrorMsg('Full name and email are required.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await apiFetch<{
        user: { id: string; email: string; name: string };
        temporaryPassword?: string;
      }>('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newUserName.trim(),
          email: newUserEmail.trim(),
          password: newUserPassword.trim() || undefined,
          teamId: selectedTeamId || undefined,
          role: selectedRole,
          isOrgAdmin: selectedRole === 'admin',
        }),
      });

      setCreatedCredentials({
        name: res.data.user.name,
        email: res.data.user.email,
        password: res.data.temporaryPassword || newUserPassword,
      });

      // Reset form fields
      setNewUserName('');
      setNewUserEmail('');
      setNewUserPassword('');
      setShowAddModal(false);

      // Refresh table
      await loadData();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to provision user account.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyToClipboard = () => {
    if (!createdCredentials) return;
    const text = `Newtonite Workspace Credentials\nURL: ${window.location.origin}/login\nEmail: ${createdCredentials.email}\nPassword: ${createdCredentials.password}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', padding: 'var(--space-5)' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-5)',
          paddingBottom: 'var(--space-4)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--color-bg-subtle)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              ADMINISTRATION
            </span>
            <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
              ORG: {user?.orgSlug || 'workspace'}
            </span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0, color: 'var(--color-text-primary)' }}>
            Organization & Team Provisioning
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: '4px 0 0 0' }}>
            Manage team accounts, provision credentials, and audit operational access.
          </p>
        </div>

        <button
          id="admin-add-user-btn"
          type="button"
          onClick={() => {
            setShowAddModal(true);
            setErrorMsg(null);
          }}
          style={{
            padding: '8px 14px',
            fontSize: '13px',
            fontWeight: 600,
            backgroundColor: 'var(--color-text-primary)',
            color: 'var(--color-text-inverse)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          + Add Team Member
        </button>
      </div>

      {/* Metrics Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '12px',
          marginBottom: 'var(--space-5)',
        }}
      >
        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 16px',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
            Total Members
          </div>
          <div style={{ fontSize: '22px', fontWeight: 700, marginTop: '4px' }}>{users.length}</div>
        </div>

        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 16px',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
            Configured Teams
          </div>
          <div style={{ fontSize: '22px', fontWeight: 700, marginTop: '4px' }}>{teams.length}</div>
        </div>

        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 16px',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
            Dead-Letter Events
          </div>
          <Link
            to="/dead-letters"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--color-accent)',
              textDecoration: 'none',
              display: 'inline-block',
              marginTop: '8px',
            }}
          >
            Review Outbox Queue &rarr;
          </Link>
        </div>
      </div>

      {/* Newly Generated Credentials Alert */}
      {createdCredentials && (
        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-accent-border)',
            borderLeft: '4px solid var(--color-accent)',
            borderRadius: 'var(--radius-sm)',
            padding: '16px',
            marginBottom: 'var(--space-5)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)' }}>
              New Account Provisioned &mdash; Hand Credentials to User
            </div>
            <button
              type="button"
              onClick={() => setCreatedCredentials(null)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '12px',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>

          <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '0 0 12px 0' }}>
            This temporary password is only displayed once. Copy and share it securely with <strong>{createdCredentials.name}</strong>.
          </p>

          <div
            style={{
              backgroundColor: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div><strong>Email:</strong> {createdCredentials.email}</div>
              <div><strong>Password:</strong> {createdCredentials.password}</div>
            </div>
            <button
              type="button"
              onClick={copyToClipboard}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied to Clipboard!' : 'Copy Credentials'}
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div
          style={{
            padding: '10px 12px',
            backgroundColor: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
            border: '1px solid var(--color-danger)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12px',
            marginBottom: 'var(--space-4)',
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Users Table */}
      <div
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-border)',
            fontWeight: 600,
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Team Members ({users.length})</span>
          <button
            type="button"
            onClick={loadData}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            Refresh List
          </button>
        </div>

        {isLoading ? (
          <div style={{ padding: '32px', textAlign: 'center', fontSize: '13px', color: 'var(--color-text-muted)' }}>
            Loading organization users...
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--color-bg-subtle)', borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ padding: '8px 16px', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                  Name & Email
                </th>
                <th style={{ padding: '8px 16px', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                  Role
                </th>
                <th style={{ padding: '8px 16px', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                  Assigned Teams
                </th>
                <th style={{ padding: '8px 16px', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                  Status
                </th>
                <th style={{ padding: '8px 16px', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                  Last Login
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  style={{
                    borderBottom: '1px solid var(--color-border-subtle)',
                    transition: 'background-color 0.1s ease',
                  }}
                >
                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{u.name}</div>
                    <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
                      {u.email}
                    </div>
                  </td>

                  <td style={{ padding: '10px 16px' }}>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: u.isOrgAdmin ? 'var(--color-bg-subtle)' : 'transparent',
                        color: u.isOrgAdmin ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        border: u.isOrgAdmin ? '1px solid var(--color-border)' : 'none',
                      }}
                    >
                      {u.isOrgAdmin ? 'Org Admin' : 'Member'}
                    </span>
                  </td>

                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {u.teams.length > 0 ? (
                        u.teams.map((t) => (
                          <span
                            key={t.teamId}
                            style={{
                              fontSize: '11px',
                              fontFamily: 'var(--font-mono)',
                              padding: '1px 5px',
                              borderRadius: 'var(--radius-sm)',
                              backgroundColor: 'var(--color-bg-subtle)',
                              border: '1px solid var(--color-border-subtle)',
                            }}
                          >
                            {t.teamSlug}:{t.role}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>None</span>
                      )}
                    </div>
                  </td>

                  <td style={{ padding: '10px 16px' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: u.isActive ? 'var(--status-resolved)' : 'var(--color-danger)',
                      }}
                    >
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          backgroundColor: u.isActive ? 'var(--status-resolved)' : 'var(--color-danger)',
                        }}
                      />
                      {u.isActive ? 'Active' : 'Deactivated'}
                    </span>
                  </td>

                  <td style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal: Add New Team Member */}
      {showAddModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--space-4)',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              width: '100%',
              maxWidth: '440px',
              padding: '24px',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>Provision New Team Member</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', color: 'var(--color-text-muted)' }}
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleCreateUser}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Alex Morgan"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  placeholder="alex@company.com"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                  Password (optional)
                </label>
                <input
                  type="password"
                  placeholder="Leave blank to auto-generate strong password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                    Assign Team
                  </label>
                  <select
                    value={selectedTeamId}
                    onChange={(e) => setSelectedTeamId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: '13px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: 'var(--color-bg-surface)',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.prefix})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                    Role Authority
                  </label>
                  <select
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value as any)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: '13px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: 'var(--color-bg-surface)',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    <option value="member">Member</option>
                    <option value="lead">Team Lead</option>
                    <option value="viewer">Viewer (Read-only)</option>
                    <option value="admin">Org Admin</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  style={{
                    padding: '8px 14px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: 600,
                    backgroundColor: 'var(--color-text-primary)',
                    color: 'var(--color-text-inverse)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isSubmitting ? 'Provisioning...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
