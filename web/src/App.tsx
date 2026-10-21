import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { LandingPage } from './pages/LandingPage';
import { OnboardingPage } from './pages/OnboardingPage';

const AttentionHome = lazy(() => import('./pages/AttentionHome').then((m) => ({ default: m.AttentionHome })));
const AllWorkList = lazy(() => import('./pages/AllWorkList').then((m) => ({ default: m.AllWorkList })));
const ItemDetail = lazy(() => import('./pages/ItemDetail').then((m) => ({ default: m.ItemDetail })));
const TeamsPage = lazy(() => import('./pages/TeamsPage').then((m) => ({ default: m.TeamsPage })));
const DeadLettersPage = lazy(() => import('./pages/DeadLettersPage').then((m) => ({ default: m.DeadLettersPage })));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard').then((m) => ({ default: m.AdminDashboard })));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage').then((m) => ({ default: m.AuthCallbackPage })));

const PageLoader: React.FC = () => (
  <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-bg-app)' }}>
    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading...</div>
  </div>
);

/**
 * Main Layout wrapper:
 * - If unauthenticated and on root '/', render the full-screen LandingPage.
 * - If unauthenticated and on an internal route, redirect to /login.
 * - If authenticated, render the Layout wrapper containing child views.
 */
const MainLayoutRoute: React.FC = () => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <PageLoader />;
  }

  if (!user) {
    if (location.pathname === '/') {
      return <LandingPage />;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Layout />;
};

export const App: React.FC = () => {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public auth & onboarding routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/onboard" element={<OnboardingPage />} />
        <Route path="/register" element={<OnboardingPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        {/* Application Layout Route */}
        <Route path="/" element={<MainLayoutRoute />}>
          <Route index element={<AttentionHome />} />
          <Route path="work" element={<AllWorkList />} />
          <Route path="items/:id" element={<ItemDetail />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="dead-letters" element={<DeadLettersPage />} />
          <Route path="admin" element={<AdminDashboard />} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
};

