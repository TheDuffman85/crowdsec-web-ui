import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Alerts } from "./pages/Alerts";
import { Decisions } from "./pages/Decisions";
import { RefreshProvider } from "./contexts/RefreshContext";

function App() {
  return (
    <RefreshProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="decisions" element={<Decisions />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </RefreshProvider>
  );
}

export default App;
