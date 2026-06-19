import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from "./components/Layout";
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

function RouteFallback() {
  const { t } = useI18n();

  return <div className="text-center p-8 text-gray-500">{t('app.loading')}</div>;
}

// Inner component to access refresh context
function AppContent() {
  const { syncStatus } = useRefresh();

  return (
    <>
      <SyncOverlay syncStatus={syncStatus} />
      <BrowserRouter basename={getBasePath() || '/'}>
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
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  );
}

function App() {
  return (
    <RefreshProvider>
      <NotificationUnreadProvider>
        <AppContent />
      </NotificationUnreadProvider>
    </RefreshProvider>
  );
}

export default App;
