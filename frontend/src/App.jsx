import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Alerts } from "./pages/Alerts";
import { Decisions } from "./pages/Decisions";
import { RefreshProvider, useRefresh } from "./contexts/RefreshContext";
import { SyncOverlay } from "./components/SyncOverlay";
import { getBasePath } from "./lib/basePath";

// Inner component to access refresh context
function AppContent() {
  const { syncStatus } = useRefresh();

  return (
    <>
      <SyncOverlay syncStatus={syncStatus} />
      <BrowserRouter basename={getBasePath() || '/'}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="decisions" element={<Decisions />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  );
}

function App() {
  return (
    <RefreshProvider>
      <AppContent />
    </RefreshProvider>
  );
}

export default App;
