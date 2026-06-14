import type { ReactNode } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Login from './pages/Login';
import Vault from './pages/Vault';
import Users from './pages/Users';
import Groups from './pages/Groups';
import Settings from './pages/Settings';
import EncryptedMetadataSettings from './pages/EncryptedMetadataSettings';
import Layout from './components/Layout';
import { LockGate, LS_JWT } from './crypto/KeyContext';

/**
 * Guards protected routes by JWT presence only. The deeper E2EE "is the key
 * unlocked?" check is handled separately by LockGate (UnlockGuard) below.
 */
function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = !!localStorage.getItem(LS_JWT);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

/**
 * The shell for all protected pages:
 *   ProtectedRoute (JWT gate)
 *     -> LockGate (UnlockGuard: if authenticated-but-locked, render the passphrase-only
 *        Unlock screen instead of the page; only renders the page once unlocked; if no
 *        stored key exists it redirects to /login)
 *       -> Layout (sidebar shell) -> <Outlet/> renders the active page.
 */
function ProtectedShell() {
  return (
    <ProtectedRoute>
      <LockGate>
        <Layout>
          <Outlet />
        </Layout>
      </LockGate>
    </ProtectedRoute>
  );
}

function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected (rendered inside the Layout shell, guarded + unlock-gated) */}
      <Route element={<ProtectedShell />}>
        <Route path="/" element={<Vault />} />
        <Route path="/users" element={<Users />} />
        <Route path="/groups" element={<Groups />} />
        <Route path="/settings" element={<Settings />} />
        {/* Admin-only encrypted-metadata config (the page self-gates on admin
            role and redirects non-admins). Inherits ProtectedRoute + LockGate +
            Layout from this route group. */}
        <Route
          path="/settings/encrypted-metadata"
          element={<EncryptedMetadataSettings />}
        />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
