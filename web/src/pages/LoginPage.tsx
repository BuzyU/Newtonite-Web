import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { useNavigate, Link } from 'react-router-dom';

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
          maxWidth: '420px',
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-6)',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
        }}
      >
        {/* Brand Header */}
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.06em' }}>NEWTONITE</span>
            </Link>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--color-bg-subtle)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              OPERATIONS PLATFORM
            </span>
          </div>
          <h1 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 4px 0', color: 'var(--color-text-primary)' }}>
            Sign In to Workspace
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
            Enter your credentials to access operations items.
          </p>
        </div>

        {/* Error message */}
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
              lineHeight: 1.4,
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <label
              htmlFor="login-email"
              style={{
                display: 'block',
                fontSize: '12px',
                fontWeight: 500,
                marginBottom: '4px',
                color: 'var(--color-text-primary)',
              }}
            >
              Email address
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@company.com"
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: '13px',
                fontFamily: 'var(--font-sans)',
                backgroundColor: 'var(--color-bg-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: 'var(--space-4)' }}>
            <label
              htmlFor="login-password"
              style={{
                display: 'block',
                fontSize: '12px',
                fontWeight: 500,
                marginBottom: '4px',
                color: 'var(--color-text-primary)',
              }}
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: '13px',
                fontFamily: 'var(--font-sans)',
                backgroundColor: 'var(--color-bg-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <button
            id="login-submit-btn"
            type="submit"
            disabled={isSubmitting}
            style={{
              width: '100%',
              padding: '9px 14px',
              fontSize: '13px',
              fontWeight: 600,
              backgroundColor: 'var(--color-text-primary)',
              color: 'var(--color-text-inverse)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.7 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {/* Organization Creation CTA */}
        <div
          style={{
            marginTop: 'var(--space-5)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-border-subtle)',
            textAlign: 'center',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
          }}
        >
          <span>Need a workspace for your team? </span>
          <Link
            to="/register"
            style={{
              color: 'var(--color-accent)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Create for your Organization &rarr;
          </Link>
        </div>

        {/* Demo Accounts (in DEV or with VITE_ENABLE_DEMO_LOGIN) */}
        {showDemoAccounts && (
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-subtle)' }}>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--color-text-muted)',
                marginBottom: '8px',
              }}
            >
              Demo Accounts (Click to Fill)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => handleSelectDemo(acc)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    fontSize: '11px',
                    backgroundColor: 'var(--color-bg-subtle)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{acc.name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>{acc.role}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
