import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export const LandingPage: React.FC = () => {
  const { user, loading } = useAuth();

  // If already logged in, navigate straight to dashboard
  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg-app)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-sans)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Navigation Header */}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '0.08em' }}>NEWTONITE</span>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Link
            to="/login"
            style={{
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--color-text-primary)',
              textDecoration: 'none',
              padding: '6px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              backgroundColor: 'var(--color-bg-surface)',
            }}
          >
            Sign In
          </Link>
          <Link
            to="/register"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--color-text-inverse)',
              textDecoration: 'none',
              padding: '7px 14px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--color-text-primary)',
            }}
          >
            Create for your Organization
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <main style={{ flex: 1, maxWidth: '1040px', margin: '0 auto', padding: '64px var(--space-6) 48px' }}>
        <div style={{ textAlign: 'center', maxWidth: '720px', margin: '0 auto 56px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '3px 10px',
              borderRadius: '12px',
              backgroundColor: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '20px',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: 'var(--status-resolved)',
              }}
            />
            HIGH-CONCURRENCY WORKSPACE
          </div>

          <h1
            style={{
              fontSize: '38px',
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              margin: '0 0 16px 0',
              color: 'var(--color-text-primary)',
            }}
          >
            Operational work, with clear ownership.
          </h1>

          <p
            style={{
              fontSize: '16px',
              lineHeight: 1.5,
              color: 'var(--color-text-secondary)',
              margin: '0 0 32px 0',
            }}
          >
            Coordinate requests, investigations, incidents, and approvals in one accountable workspace.
            Deterministic state machines, optimistic concurrency control, and complete tenant isolation.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <Link
              to="/register"
              id="landing-create-org-btn"
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--color-text-inverse)',
                backgroundColor: 'var(--color-text-primary)',
                padding: '11px 22px',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              Create your organization &rarr;
            </Link>

            <Link
              to="/login"
              id="landing-login-btn"
              style={{
                fontSize: '14px',
                fontWeight: 500,
                color: 'var(--color-text-primary)',
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                padding: '10px 20px',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
              }}
            >
              Sign in
            </Link>
          </div>
        </div>

        {/* Feature Grid: Clean, minimalist, NO AI colors, NO AI emojis */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: '16px',
            marginBottom: '48px',
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '20px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-accent)',
                marginBottom: '8px',
              }}
            >
              [OCC_ENGINE]
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 6px 0' }}>
              Optimistic Concurrency
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.45 }}>
              Strict versioning via HTTP ETags and If-Match preconditions prevents lost updates and mid-air collisions.
            </p>
          </div>

          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '20px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-accent)',
                marginBottom: '8px',
              }}
            >
              [AUDIT_LEDGER]
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 6px 0' }}>
              Immutable Audit Trail
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.45 }}>
              Database triggers protect activity records from modification or deletion. Full forensic history per item.
            </p>
          </div>

          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '20px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-accent)',
                marginBottom: '8px',
              }}
            >
              [MULTI_TENANT]
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 6px 0' }}>
              Organization Isolation
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.45 }}>
              Strict organization partitioning with custom team scopes, role enforcement, and administrator provisioning.
            </p>
          </div>

          <div
            style={{
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '20px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-accent)',
                marginBottom: '8px',
              }}
            >
              [OUTBOX_SKIP_LOCKED]
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 6px 0' }}>
              Transactional Outbox
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.45 }}>
              Zero dual-write anomalies. High-throughput outbox queue polled with PostgreSQL SKIP LOCKED.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-bg-surface)',
          padding: '16px var(--space-6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12px',
          color: 'var(--color-text-muted)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: 'var(--status-resolved)',
            }}
          />
          <span>SYSTEM READY</span>
        </div>
        <div>NEWTONITE &copy; {new Date().getFullYear()} &mdash; OPERATIONS UNDER PRESSURE</div>
      </footer>
    </div>
  );
};
