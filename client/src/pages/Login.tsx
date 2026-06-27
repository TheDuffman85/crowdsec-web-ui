import { useState, type FormEvent } from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl, assetUrl } from '../lib/basePath';
import {
  serializeAuthenticationCredential,
  toPublicKeyCredentialRequestOptions,
} from '../lib/webauthn';

export function Login() {
  const { authEnabled, authenticated, login, oidcEnabled, passwordLoginDisabled, passkeysEnabled, refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  if (!authEnabled || authenticated) {
    return <Navigate to="/" replace />;
  }

  const handlePasswordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await login(username, password);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError('');
    setIsLoading(true);
    try {
      if (!window.isSecureContext || !navigator.credentials) {
        throw new Error('Passkeys require HTTPS or localhost');
      }

      const optionsResponse = await fetch(apiUrl('/api/auth/webauthn/login/options'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      if (!optionsResponse.ok) throw new Error('Failed to start passkey login');
      const options = toPublicKeyCredentialRequestOptions(await optionsResponse.json() as Record<string, unknown>);
      const credential = await navigator.credentials.get({ publicKey: options }) as PublicKeyCredential | null;
      if (!credential) throw new Error('No passkey credential returned');

      const verifyResponse = await fetch(apiUrl('/api/auth/webauthn/login/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serializeAuthenticationCredential(credential)),
      });
      if (!verifyResponse.ok) {
        const payload = await verifyResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || 'Passkey authentication failed');
      }
      await refresh();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : 'Passkey authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4 text-gray-100">
      <div className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <img src={assetUrl('/logo.svg')} alt="" className="mx-auto h-14 w-14" />
          <h1 className="mt-4 text-2xl font-bold">Welcome back</h1>
          <p className="mt-1 text-sm text-gray-400">Sign in to your CrowdSec dashboard</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {!passwordLoginDisabled && (
          <form onSubmit={(event) => void handlePasswordLogin(event)} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="login-username" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                Username
              </label>
              <input
                id="login-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoComplete="username"
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" />
              Sign In
            </button>
          </form>
        )}

        {(passkeysEnabled || oidcEnabled) && (
          <div className={`${passwordLoginDisabled ? '' : 'mt-4'} space-y-2`}>
            {passkeysEnabled && (
              <button
                type="button"
                onClick={() => void handlePasskeyLogin()}
                disabled={isLoading}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" />
                Sign In with Passkey
              </button>
            )}
            {oidcEnabled && (
              <a
                href={apiUrl('/api/auth/oidc/login')}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-800"
              >
                <ShieldCheck className="h-4 w-4" />
                Continue with SSO
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
