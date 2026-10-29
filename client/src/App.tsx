import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { BrandingProvider } from './contexts/BrandingContext';
import { NotificationUnreadProvider } from "./contexts/NotificationUnreadContext";
import { RefreshProvider } from "./contexts/RefreshContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useRefresh } from "./contexts/useRefresh";
import { SyncOverlay } from "./components/SyncOverlay";
import { getBasePath } from "./lib/basePath";
import { normalizeLanguagePreference, useI18n } from "./lib/i18n";
import { normalizeFontPreference, useFont } from "./lib/font";

const Dashboard = lazy(async () => ({ default: (await import('./pages/Dashboard')).Dashboard }));
const Alerts = lazy(async () => ({ default: (await import('./pages/Alerts')).Alerts }));
const Decisions = lazy(async () => ({ default: (await import('./pages/Decisions')).Decisions }));
const Allowlists = lazy(async () => ({ default: (await import('./pages/Allowlists')).Allowlists }));
const Metrics = lazy(async () => ({ default: (await import('./pages/Metrics')).Metrics }));
const Notifications = lazy(async () => ({ default: (await import('./pages/Notifications')).Notifications }));
const Settings = lazy(async () => ({ default: (await import('./pages/Settings')).Settings }));
const Login = lazy(async () => ({ default: (await import('./pages/Login')).Login }));
const Setup = lazy(async () => ({ default: (await import('./pages/Setup')).Setup }));
const PasswordChange = lazy(async () => ({ default: (await import('./pages/PasswordChange')).PasswordChange }));

function RouteFallback() {
  const { t } = useI18n();

  return <div className="text-center p-8 text-gray-500">{t('app.loading')}</div>;
}

// Applies the language and font the signed-in user saved, so they follow the user across browsers.
function useUserPreferenceSync() {
  const { authenticated, preferences, user } = useAuth();
  const { setLanguagePreference } = useI18n();
  const { setFontPreference } = useFont();
  const userId = user?.userId;
  const language = preferences?.language;
  const font = preferences?.font;

  useEffect(() => {
    if (!authenticated || userId === undefined) return;
    if (language) setLanguagePreference(normalizeLanguagePreference(language), { sync: false });
    if (font) setFontPreference(normalizeFontPreference(font), { sync: false });
  }, [authenticated, font, language, setFontPreference, setLanguagePreference, userId]);
}

function ProtectedProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <RefreshProvider>
        <NotificationUnreadProvider>
          {children}
        </NotificationUnreadProvider>
      </RefreshProvider>
    </ToastProvider>
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
            path="allowlists"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Allowlists />
              </Suspense>
            )}
          />
          <Route
            path="metrics"
            element={(
              <Suspense fallback={<RouteFallback />}>
                <Metrics />
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
  const { authEnabled, authenticated, loading, passwordChangeRequired, setupRequired } = useAuth();
  useUserPreferenceSync();

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

  if (authEnabled && passwordChangeRequired) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PasswordChange />
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
    <BrandingProvider>
      <AuthProvider>
        <BrowserRouter basename={getBasePath() || '/'}>
          <AuthenticatedRoutes />
        </BrowserRouter>
      </AuthProvider>
    </BrandingProvider>
  );
}

export default App;
