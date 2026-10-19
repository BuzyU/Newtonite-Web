import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { apiFetch, ApiError } from '../api';
import { useAuth } from '../AuthContext';

export const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isNotInvited, setIsNotInvited] = useState(false);
  const calledOnce = useRef(false);

  useEffect(() => {
    if (calledOnce.current) return;
    calledOnce.current = true;

    async function handleCallback() {
      if (!supabase) {
        setErrorMsg('Google login is not enabled on this environment.');
        return;
      }

      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session?.access_token) {
          setErrorMsg(sessionError?.message || 'Unable to retrieve authentication session from Supabase.');
          return;
        }

        const accessToken = session.access_token;

        // 1. Post access token to our backend API once
        await apiFetch('/api/v1/auth/google', {
          method: 'POST',
          body: JSON.stringify({ accessToken }),
          headers: { 'Content-Type': 'application/json' },
        });

        // 2. Local signOut: clear Supabase local storage so only our secure session cookie remains
        await supabase.auth.signOut({ scope: 'local' });

        // 3. Refresh user state in AuthContext and navigate to home
        await refreshUser();
        navigate('/');
      } catch (err: any) {
        try {
          await supabase?.auth.signOut({ scope: 'local' });
        } catch {
          // ignore
        }

        if (err instanceof ApiError && err.code === 'NOT_INVITED') {
          setIsNotInvited(true);
          setErrorMsg(err.message || 'Ask your team admin to add you.');
        } else {
          setErrorMsg(err.message || 'Failed to authenticate with Google.');
        }
      }
    }

    handleCallback();
  }, [navigate, refreshUser]);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-bg-app)',
        padding: 'var(--space-4)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '440px',
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
          textAlign: 'center',
        }}
      >
        {!errorMsg ? (
          <div>
            <div className="skeleton" style={{ height: '24px', width: '200px', margin: '0 auto 16px auto' }} />
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
              Verifying credentials and establishing your session...
            </p>
          </div>
        ) : (
          <div>
            <div
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: isNotInvited ? 'var(--color-warning)' : 'var(--color-danger)',
                marginBottom: '8px',
              }}
            >
              {isNotInvited ? 'Access Restricted: Account Not Invited' : 'Authentication Failed'}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
              {errorMsg}
            </p>
            {isNotInvited && (
              <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '20px' }}>
                Newtonite is an invite-only operational platform. Contact your team lead or organization administrator to grant membership.
              </p>
            )}
            <Link to="/login" className="btn btn-secondary" style={{ display: 'inline-block' }}>
              Back to Sign In
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};
