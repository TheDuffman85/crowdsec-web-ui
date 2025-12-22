import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Alerts } from "./pages/Alerts";
import { Decisions } from "./pages/Decisions";
import { Allowlist } from "./pages/Allowlist";
import { RefreshProvider } from "./contexts/RefreshContext";
import { CapabilityProvider } from "./contexts/CapabilityContext";

function App() {
  return (
    <CapabilityProvider>
      <RefreshProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="decisions" element={<Decisions />} />
              <Route path="allowlist" element={<Allowlist />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </RefreshProvider>
    </CapabilityProvider>
  );
}

export default App;
