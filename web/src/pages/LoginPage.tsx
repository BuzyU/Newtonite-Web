import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { useNavigate } from 'react-router-dom';

const DEMO_ACCOUNTS = [
  { name: 'Priya Patel', role: 'Ops Lead / Eng Viewer', email: 'priya@newtonite.internal', pass: 'demo-password-123' },
  { name: 'Elena Rostova', role: 'Engineering Lead', email: 'elena@newtonite.internal', pass: 'demo-password-123' },
  { name: 'Sarah Chen', role: 'Support Lead', email: 'sarah@newtonite.internal', pass: 'demo-password-123' },
  { name: 'Arjun Das', role: 'Ops Member', email: 'arjun@newtonite.internal', pass: 'demo-password-123' },
  { name: 'Sofia Rodriguez', role: 'Engineering Member', email: 'sofia@newtonite.internal', pass: 'demo-password-123' },
  { name: 'Admin User', role: 'Org Administrator', email: 'admin@newtonite.internal', pass: 'admin-secret-password' },
];

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelectDemo = (acc: typeof DEMO_ACCOUNTS[0]) => {
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
      navigate('/');
    } catch (err: any) {
      setErrorMsg(err.message || 'Invalid email or password');
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
        }}
      >
        <div style={{ marginBottom: 'var(--space-6)' }}>
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
            Sign in to access your team queue and operational items.
          </p>
        </div>

        {errorMsg && (
          <div
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

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div>
            <label
              htmlFor="login-email"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}
            >
              Email address
            </label>
            <input
              id="login-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@newtonite.internal"
              required
              autoFocus
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: '4px' }}
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 'var(--space-2)' }}
            disabled={isSubmitting}
            id="login-submit-btn"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div style={{ marginTop: 'var(--space-6)', borderTop: '1px solid var(--color-border-subtle)', paddingTop: 'var(--space-4)' }}>
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
      </div>
    </div>
  );
};
