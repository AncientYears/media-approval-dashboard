import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import "./App.css";
import Dashboard from "./pages/Dashboard";
import RequestDetail from "./pages/RequestDetail";
import FranchiseDetail from "./pages/FranchiseDetail";
import Settings from "./pages/Settings";
import DatabaseViewer from "./pages/DatabaseViewer";
import { ToastProvider } from "./components/Toast";
import WorkspaceOverview from "./components/WorkspaceOverview";

function App() {
  return (
    <ToastProvider>
    <Router>
      <div className="app">
        <nav className="navbar">
          <div className="nav-container">
            <div className="nav-brand">
              <Link to="/"><h1>Media Dashboard</h1></Link>
            </div>
            <ul className="nav-links">
              <li>
                <WorkspaceOverview />
              </li>
              <li>
                <Link to="/">Dashboard</Link>
              </li>
              <li>
                <Link to="/db">DB</Link>
              </li>
              <li>
                <Link to="/settings">Settings</Link>
              </li>
            </ul>
          </div>
        </nav>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/db" element={<DatabaseViewer />} />
            <Route path="/requests/:id" element={<RequestDetail />} />
            <Route path="/managed/:sonarrId" element={<FranchiseDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </Router>
    </ToastProvider>
  );
}

export default App;
