import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import "./App.css";
import Dashboard from "./pages/Dashboard";
import RequestDetail from "./pages/RequestDetail";
import Settings from "./pages/Settings";

function App() {
  return (
    <Router>
      <div className="app">
        <nav className="navbar">
          <div className="nav-container">
            <div className="nav-brand">
              <h1>📋 Media Approval Dashboard</h1>
            </div>
            <ul className="nav-links">
              <li>
                <Link to="/">Dashboard</Link>
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
            <Route path="/requests/:id" element={<RequestDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
