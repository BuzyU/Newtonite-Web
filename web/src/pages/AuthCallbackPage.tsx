import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Legacy OAuth callback route:
 * Google sign-in has been removed from the platform. Any navigation here
 * is immediately redirected to the primary password authentication page.
 */
export const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/login', { replace: true });
  }, [navigate]);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-bg-app)',
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        color: 'var(--color-text-secondary)',
      }}
    >
      Redirecting to sign in...
    </div>
  );
};
