import { useState, type FormEvent } from 'react';
import { ShieldPlus } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { assetUrl } from '../lib/basePath';

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/\d/.test(password)) return 'Password must contain a digit';
  return null;
}

export function Setup() {
  const { authEnabled, setupRequired, setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  if (!authEnabled || !setupRequired) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setIsLoading(true);
    try {
      await setup(username, password);
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Setup failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4 text-gray-100">
      <div className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <img src={assetUrl('/logo-sidebar.png')} alt="" className="mx-auto h-14 w-14" />
          <h1 className="mt-4 text-2xl font-bold">Initial setup</h1>
          <p className="mt-1 text-sm text-gray-400">Create your administrator account</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="setup-username" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
              Username
            </label>
            <input
              id="setup-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="username"
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="setup-password" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
              Password
            </label>
            <input
              id="setup-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
            />
            <p className="text-xs text-gray-500">Minimum 8 characters with uppercase, lowercase, and a digit.</p>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ShieldPlus className="h-4 w-4" />
            Create Account
          </button>
        </form>
      </div>
    </div>
  );
}
