import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { useNavigate } from 'react-router-dom';
import { isGoogleLoginEnabled, supabase } from '../supabase';

const DEMO_ACCOUNTS = [
  { name: 'Alice Admin', role: 'Org Administrator', email: 'admin@newtonite.local', pass: 'Password123!' },
  { name: 'Priya Sharma', role: 'Ops Lead / Eng Viewer', email: 'priya.lead@newtonite.local', pass: 'Password123!' },
  { name: 'Arjun Patel', role: 'Engineering Lead', email: 'arjun.lead@newtonite.local', pass: 'Password123!' },
  { name: 'Elena Rostova', role: 'Ops Member', email: 'elena.member@newtonite.local', pass: 'Password123!' },
  { name: 'Sarah Jenkins', role: 'Ops Viewer', email: 'sarah.viewer@newtonite.local', pass: 'Password123!' },
  { name: 'Sofia Rossi', role: 'Payments Lead', email: 'sofia.lead@newtonite.local', pass: 'Password123!' },
];

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const showDemoAccounts = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_LOGIN === 'true';

  const handleSelectDemo = (acc: (typeof DEMO_ACCOUNTS)[0]) => {
    setEmail(acc.email);
    setPassword(acc.pass);
    setErrorMsg(null);
  };

  const handleGoogleSignIn = async () => {
    if (!isGoogleLoginEnabled || !supabase) {
      setErrorMsg('Google Sign-In is not configured for this deployment.');
      return;
    }
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to initialize Google authentication.');
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      await login(email, password);
      const params = new URLSearchParams(window.location.search);
      navigate(params.get('redirect') || '/');
    } catch (err: any) {
      setErrorMsg(err.message || 'Invalid email or password.');
    } finally {
      setIsSubmitting(false);
    }
  };

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
        }}
      >
        {/* Brand Header */}
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.05em' }}>NEWTONITE</span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '1px 6px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--color-accent-subtle)',
                color: 'var(--color-accent)',
              }}
            >
              OPERATIONS
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
            Sign in to your workspace.
          </p>
        </div>

        {/* Google Sign In Button — only shown when enabled */}
        {isGoogleLoginEnabled && (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleGoogleSignIn}
              disabled={isSubmitting}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '10px 14px',
                fontWeight: 500,
                fontSize: '13px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                border: '1px solid var(--color-border)',
              }}
              id="google-signin-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              Sign in with Google
            </button>
            {/* Divider */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                margin: 'var(--space-4) 0 var(--space-2)',
                color: 'var(--color-text-muted)',
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--color-border-subtle)' }} />
              <span style={{ padding: '0 8px' }}>or continue with email</span>
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--color-border-subtle)' }} />
            </div>
          </div>
        )}

        {/* Error Message */}
        {errorMsg && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-danger)',
              color: 'var(--color-danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '13px',
              marginBottom: 'var(--space-4)',
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Email & Password Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div>
            <label
              htmlFor="auth-email"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}
            >
              Email address
            </label>
            <input
              id="auth-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              required
              autoFocus
              autoComplete="email"
            />
          </div>

          <div>
            <label
              htmlFor="auth-password"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}
            >
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 'var(--space-2)' }}
            disabled={isSubmitting}
            id="auth-submit-btn"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {/* Invite-only note */}
        <p
          style={{
            fontSize: '12px',
            color: 'var(--color-text-muted)',
            textAlign: 'center',
            marginTop: 'var(--space-4)',
          }}
        >
          Don&rsquo;t have an account? Contact your team admin.
        </p>

        {/* Demo Profiles (Only in Development or explicit demo mode) */}
        {showDemoAccounts && (
          <div style={{ marginTop: 'var(--space-5)', borderTop: '1px solid var(--color-border-subtle)', paddingTop: 'var(--space-4)' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
              Demo Profiles (1-click fill)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handleSelectDemo(acc)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '12px',
                    padding: '6px 8px',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    textAlign: 'left',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>{acc.name}</span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginLeft: '6px' }}>({acc.role})</span>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--color-accent)' }}>Use</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
