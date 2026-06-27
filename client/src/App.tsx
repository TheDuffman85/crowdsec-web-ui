import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationUnreadProvider } from "./contexts/NotificationUnreadContext";
import { RefreshProvider } from "./contexts/RefreshContext";
import { useRefresh } from "./contexts/useRefresh";
import { SyncOverlay } from "./components/SyncOverlay";
import { getBasePath } from "./lib/basePath";
import { useI18n } from "./lib/i18n";

const Dashboard = lazy(async () => ({ default: (await import('./pages/Dashboard')).Dashboard }));
const Alerts = lazy(async () => ({ default: (await import('./pages/Alerts')).Alerts }));
const Decisions = lazy(async () => ({ default: (await import('./pages/Decisions')).Decisions }));
const Notifications = lazy(async () => ({ default: (await import('./pages/Notifications')).Notifications }));
const Settings = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const Login = lazy(async () => ({ default: (await import('./pages/Login')).Login }));
const Setup = lazy(async () => ({ default: (await import('./pages/Setup')).Setup }));

function RouteFallback() {
  const { t } = useI18n();

  return <div className="text-center p-8 text-gray-500">{t('app.loading')}</div>;
}

function ProtectedProviders({ children }: { children: ReactNode }) {
  return (
    <RefreshProvider>
      <NotificationUnreadProvider>
        {children}
      </NotificationUnreadProvider>
    </RefreshProvider>
  );
}

function ProtectedAppShell() {
  const { syncStatus } = useRefresh();

  return (
    <>
      <SyncOverlay syncStatus={syncStatus} />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route
            index
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Dashboard />
              </Suspense>
            )}
          />
          <Route
            path="alerts"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Alerts />
              </Suspense>
            )}
          />
          <Route
            path="decisions"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Decisions />
              </Suspense>
            )}
          />
          <Route
            path="notifications"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Notifications />
              </Suspense>
            )}
          />
          <Route
            path="settings"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Settings />
              </Suspense>
            )}
          />
        </Route>
        <Route path="/setup" element={<Navigate to="/" replace />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

function AuthenticatedRoutes() {
  const { authEnabled, authenticated, loading, setupRequired } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (authEnabled && setupRequired) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </Suspense>
    );
  }

  if (authEnabled && !authenticated) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <ProtectedProviders>
      <ProtectedAppShell />
    </ProtectedProviders>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={getBasePath() || '/'}>
        <AuthenticatedRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
