import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export const OnboardingPage: React.FC = () => {
  const { registerOrg } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const queryOrg = searchParams.get('org') || searchParams.get('name') || '';

  const [step, setStep] = useState<1 | 2 | 3>(queryOrg.trim() ? 2 : 1);

  // Form State
  const [orgName, setOrgName] = useState(queryOrg);
  const [orgSlug, setOrgSlug] = useState(() =>
    queryOrg.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  );
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleOrgNameChange = (val: string) => {
    setOrgName(val);
    const slugified = val.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    setOrgSlug(slugified);
  };

  const handleNextFromStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setErrorMsg('Organization name is required.');
      return;
    }
    setErrorMsg(null);
    setStep(2);
  };

  const handleNextFromStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminName.trim() || !adminEmail.trim()) {
      setErrorMsg('Admin name and work email are required.');
      return;
    }
    if (password.length < 12) {
      setErrorMsg('Password must be at least 12 characters long.');
      return;
    }
    setErrorMsg(null);
    setStep(3);
  };

  const handleFinalSubmit = async () => {
    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      await registerOrg({
        orgName: orgName.trim(),
        orgSlug: orgSlug.trim() || undefined,
        adminName: adminName.trim(),
        adminEmail: adminEmail.trim(),
        password,
      });

      // Creator is directed straight to Admin Dashboard
      navigate('/admin');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to create organization. Please verify your details.');
      setIsSubmitting(false);
      setStep(2);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg-app)',
        fontFamily: 'var(--font-sans)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-bg-surface)',
          padding: '12px var(--space-6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Link to="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.06em' }}>NEWTONITE</span>
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
            }}
          >
            ORGANIZATION SETUP
          </span>
        </Link>

        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
          Already have a team account?{' '}
          <Link to="/login" style={{ color: 'var(--color-text-primary)', fontWeight: 600, textDecoration: 'none' }}>
            Sign In
          </Link>
        </div>
      </header>

      {/* Main Container */}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
        <div
          style={{
            width: '100%',
            maxWidth: '520px',
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: '28px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
          }}
        >
          {/* Toggle between Create Org and Sign In */}
          <div
            style={{
              display: 'flex',
              backgroundColor: 'var(--color-bg-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '3px',
              border: '1px solid var(--color-border-subtle)',
              marginBottom: '20px',
            }}
          >
            <div
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'var(--color-bg-surface)',
                color: 'var(--color-text-primary)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
              }}
            >
              Create Organization
            </div>
            <Link
              to="/login"
              id="onboard-switch-login"
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 500,
                textDecoration: 'none',
                color: 'var(--color-text-secondary)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Sign In
            </Link>
          </div>

          {/* Step Progress Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
            <div
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '2px',
                backgroundColor: step >= 1 ? 'var(--color-text-primary)' : 'var(--color-border-subtle)',
              }}
            />
            <div
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '2px',
                backgroundColor: step >= 2 ? 'var(--color-text-primary)' : 'var(--color-border-subtle)',
              }}
            />
            <div
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '2px',
                backgroundColor: step >= 3 ? 'var(--color-text-primary)' : 'var(--color-border-subtle)',
              }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Step {step} of 3
            </span>
            <h2 style={{ fontSize: '20px', fontWeight: 600, margin: '4px 0 6px 0', color: 'var(--color-text-primary)' }}>
              {step === 1 && 'Create Organization Workspace'}
              {step === 2 && 'Set Master Administrator'}
              {step === 3 && 'Confirm & Launch Workspace'}
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
              {step === 1 && 'Define your company or operational division name.'}
              {step === 2 && 'Create the primary account with full administrative authority.'}
              {step === 3 && 'Review your initial configuration before launch.'}
            </p>
          </div>

          {errorMsg && (
            <div
              style={{
                padding: '10px 12px',
                backgroundColor: 'var(--color-danger-bg)',
                color: 'var(--color-danger)',
                border: '1px solid var(--color-danger)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '12px',
                marginBottom: '18px',
                lineHeight: 1.4,
              }}
            >
              {errorMsg}
            </div>
          )}

          {/* STEP 1: ORGANIZATION NAME & SLUG */}
          {step === 1 && (
            <form onSubmit={handleNextFromStep1}>
              <div style={{ marginBottom: '16px' }}>
                <label
                  htmlFor="org-name"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}
                >
                  Organization Name
                </label>
                <input
                  id="org-name"
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Apex Operations, Stripe Europe"
                  value={orgName}
                  onChange={(e) => handleOrgNameChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    fontFamily: 'var(--font-sans)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label
                  htmlFor="org-slug"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}
                >
                  Workspace Identifier (Slug)
                </label>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <input
                    id="org-slug"
                    type="text"
                    required
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    placeholder="apex-operations"
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: '13px',
                      fontFamily: 'var(--font-mono)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      boxSizing: 'border-box',
                      backgroundColor: 'var(--color-bg-surface)',
                      color: 'var(--color-text-primary)',
                    }}
                  />
                </div>
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px', display: 'block' }}>
                  Used to partition item references (e.g. OPS-1001) and security policies.
                </span>
              </div>

              <div
                style={{
                  backgroundColor: 'var(--color-bg-subtle)',
                  padding: '12px',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: '24px',
                  fontSize: '12px',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                  Pre-configured Default Teams
                </div>
                <div>Your workspace will initialize with 3 core operational units:</div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                  <span style={{ padding: '2px 6px', background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>OPS (Operations)</span>
                  <span style={{ padding: '2px 6px', background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>ENG (Platform)</span>
                  <span style={{ padding: '2px 6px', background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>PAY (Payments)</span>
                </div>
              </div>

              <button
                type="submit"
                id="onboard-step1-next"
                style={{
                  width: '100%',
                  padding: '9px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  backgroundColor: 'var(--color-text-primary)',
                  color: 'var(--color-text-inverse)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                Continue to Admin Account &rarr;
              </button>
            </form>
          )}

          {/* STEP 2: ADMINISTRATOR ACCOUNT */}
          {step === 2 && (
            <form onSubmit={handleNextFromStep2}>
              <div style={{ marginBottom: '14px' }}>
                <label
                  htmlFor="admin-name"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}
                >
                  Admin Full Name
                </label>
                <input
                  id="admin-name"
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Sarah Connor"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    fontFamily: 'var(--font-sans)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ marginBottom: '14px' }}>
                <label
                  htmlFor="admin-email"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}
                >
                  Work Email Address
                </label>
                <input
                  id="admin-email"
                  type="email"
                  required
                  placeholder="sarah@company.com"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    fontFamily: 'var(--font-sans)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </div>

              <div style={{ marginBottom: '24px' }}>
                <label
                  htmlFor="admin-password"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}
                >
                  Master Password
                </label>
                <input
                  id="admin-password"
                  type="password"
                  required
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '13px',
                    fontFamily: 'var(--font-sans)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--color-bg-surface)',
                    color: 'var(--color-text-primary)',
                  }}
                />
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px', display: 'block' }}>
                  Argon2id cryptographic hash. Grants complete organization management authority.
                </span>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  style={{
                    padding: '9px 16px',
                    fontSize: '13px',
                    fontWeight: 500,
                    backgroundColor: 'var(--color-bg-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  &larr; Back
                </button>
                <button
                  type="submit"
                  id="onboard-step2-next"
                  style={{
                    flex: 1,
                    padding: '9px 16px',
                    fontSize: '13px',
                    fontWeight: 600,
                    backgroundColor: 'var(--color-text-primary)',
                    color: 'var(--color-text-inverse)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Review Configuration &rarr;
                </button>
              </div>
            </form>
          )}

          {/* STEP 3: REVIEW & LAUNCH */}
          {step === 3 && (
            <div>
              <div
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--color-bg-subtle)',
                  padding: '16px',
                  marginBottom: '24px',
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px', fontSize: '13px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Organization:</span>
                  <span style={{ fontWeight: 600 }}>{orgName}</span>

                  <span style={{ color: 'var(--color-text-muted)' }}>Identifier:</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{orgSlug}</span>

                  <span style={{ color: 'var(--color-text-muted)' }}>Administrator:</span>
                  <span style={{ fontWeight: 600 }}>{adminName}</span>

                  <span style={{ color: 'var(--color-text-muted)' }}>Admin Email:</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{adminEmail}</span>

                  <span style={{ color: 'var(--color-text-muted)' }}>Authority:</span>
                  <span>Full Org Admin (User & Team Provisioning)</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setStep(2)}
                  style={{
                    padding: '10px 16px',
                    fontSize: '13px',
                    fontWeight: 500,
                    backgroundColor: 'var(--color-bg-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  &larr; Back
                </button>

                <button
                  type="button"
                  id="onboard-final-submit"
                  disabled={isSubmitting}
                  onClick={handleFinalSubmit}
                  style={{
                    flex: 1,
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    backgroundColor: 'var(--color-text-primary)',
                    color: 'var(--color-text-inverse)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    opacity: isSubmitting ? 0.7 : 1,
                  }}
                >
                  {isSubmitting ? 'Initializing Workspace...' : 'Launch Organization Workspace &rarr;'}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
