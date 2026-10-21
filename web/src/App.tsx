import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';

const AttentionHome = lazy(() => import('./pages/AttentionHome').then((m) => ({ default: m.AttentionHome })));
const AllWorkList = lazy(() => import('./pages/AllWorkList').then((m) => ({ default: m.AllWorkList })));
const ItemDetail = lazy(() => import('./pages/ItemDetail').then((m) => ({ default: m.ItemDetail })));
const TeamsPage = lazy(() => import('./pages/TeamsPage').then((m) => ({ default: m.TeamsPage })));
const DeadLettersPage = lazy(() => import('./pages/DeadLettersPage').then((m) => ({ default: m.DeadLettersPage })));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage').then((m) => ({ default: m.AuthCallbackPage })));

const PageLoader: React.FC = () => (
  <div style={{ display: 'flex', height: '50vh', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Loading view...</div>
  </div>
);

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Loading session...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export const App: React.FC = () => {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<AttentionHome />} />
          <Route path="work" element={<AllWorkList />} />
          <Route path="items/:id" element={<ItemDetail />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="dead-letters" element={<DeadLettersPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
};
