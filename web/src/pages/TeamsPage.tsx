import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../AuthContext';

interface Team {
  id: string;
  name: string;
  slug: string;
  my_role?: string | null;
}

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  joined_at: string;
}

export const TeamsPage: React.FC = () => {
  const { user } = useAuth();
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');

  const { data: teamsData, isLoading: isTeamsLoading } = useQuery<{ teams: Team[] }>({
    queryKey: ['teams'],
    queryFn: () => api.get<{ teams: Team[] }>('/teams'),
  });

  const teams = teamsData?.teams || [];

  React.useEffect(() => {
    if (teams.length > 0 && !selectedTeamId) {
      setSelectedTeamId(teams[0].id);
    }
  }, [teams, selectedTeamId]);

  const { data: teamDetail, isLoading: isDetailLoading } = useQuery<{ team: Team; members: Member[] }>({
    queryKey: ['team', selectedTeamId],
    queryFn: () => api.get<{ team: Team; members: Member[] }>(`/teams/${selectedTeamId}`),
    enabled: !!selectedTeamId,
  });

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div>
        <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
          Teams & Rosters
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '2px', marginBottom: 0 }}>
          Manage team memberships, view roles (Viewer, Member, Lead, Admin), and review resource scopes.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 'var(--space-6)' }}>
        {/* Teams List Column */}
        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              color: 'var(--color-text-secondary)',
              borderBottom: '1px solid var(--color-border-subtle)',
            }}
          >
            Your Teams ({teams.length})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {isTeamsLoading ? (
              <div style={{ padding: '12px' }}>
                <div className="skeleton" style={{ height: '32px', marginBottom: '8px' }} />
                <div className="skeleton" style={{ height: '32px' }} />
              </div>
            ) : (
              teams.map((t) => {
                const isSelected = t.id === selectedTeamId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTeamId(t.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      padding: '10px 14px',
                      backgroundColor: isSelected ? 'var(--color-accent-subtle)' : 'transparent',
                      border: 'none',
                      borderLeft: isSelected ? '3px solid var(--color-accent)' : '3px solid transparent',
                      borderBottom: '1px solid var(--color-border-subtle)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                    }}
                  >
                    <span style={{ fontSize: '13px', fontWeight: isSelected ? 600 : 500, color: 'var(--color-text-primary)' }}>
                      {t.name}
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                      Role: {t.my_role ? t.my_role.toUpperCase() : user?.is_org_admin ? 'ORG ADMIN' : 'NONE'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Member Roster Column */}
        <div
          style={{
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-6)',
          }}
        >
          {isDetailLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="skeleton" style={{ height: '24px', width: '200px' }} />
              <div className="skeleton" style={{ height: '100px' }} />
            </div>
          ) : teamDetail ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                <div>
                  <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
                    {teamDetail.team.name} Roster
                  </h2>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    Slug: {teamDetail.team.slug} • {teamDetail.members.length} Members
                  </span>
                </div>
              </div>

              <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {teamDetail.members.map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
                        {m.name} {m.id === user?.id && <span style={{ fontSize: '11px', color: 'var(--color-accent)' }}>(You)</span>}
                      </td>
                      <td style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>
                        {m.email}
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: 'var(--radius-sm)',
                            backgroundColor:
                              m.role === 'admin'
                                ? 'rgba(219, 43, 43, 0.1)'
                                : m.role === 'lead'
                                ? 'rgba(217, 119, 6, 0.1)'
                                : 'var(--color-bg-subtle)',
                            color:
                              m.role === 'admin'
                                ? 'var(--color-danger)'
                                : m.role === 'lead'
                                ? 'var(--color-warning)'
                                : 'var(--color-text-secondary)',
                          }}
                        >
                          {m.role.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>
                        {new Date(m.joined_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
              Select a team to view its members.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
