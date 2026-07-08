import { useState, type FormEvent } from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl, assetUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';
import {
  serializeAuthenticationCredential,
  toPublicKeyCredentialRequestOptions,
} from '../lib/webauthn';

export function Login() {
  const { authEnabled, authenticated, login, oidcEnabled, passwordLoginDisabled, passkeysEnabled, refresh } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  if (!authEnabled || authenticated) {
    return <Navigate to="/" replace />;
  }

  const validatePasswordLogin = () => {
    if (!requiresTotp) {
      if (!username.trim() || !password) return t('pages.login.validation.credentialsRequired');
      return '';
    }

    if (!totpCode.trim()) return t('pages.login.validation.totpRequired');
    if (!/^[0-9 ]+$/.test(totpCode)) return t('pages.login.validation.totpDigits');
    return '';
  };

  const translateKnownLoginError = (message: string) => {
    switch (message) {
      case 'Authenticator code required':
        return t('pages.login.error.authenticatorCodeRequired');
      case 'Invalid authenticator code':
        return t('pages.login.error.invalidAuthenticatorCode');
      case 'Login failed':
        return t('pages.login.error.loginFailed');
      case 'Failed to start passkey login':
        return t('pages.login.error.failedToStartPasskeyLogin');
      case 'No passkey credential returned':
        return t('pages.login.error.noPasskeyCredential');
      case 'Passkey authentication failed':
        return t('pages.login.error.passkeyAuthenticationFailed');
      default:
        return message;
    }
  };

  const handlePasswordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    const validationError = validatePasswordLogin();
    if (validationError) {
      setError(validationError);
      return;
    }
    setIsLoading(true);
    try {
      await login(username, password, requiresTotp ? totpCode : undefined);
    } catch (loginError) {
      if (loginError instanceof Error && 'requiresTotp' in loginError && loginError.requiresTotp === true) {
        setRequiresTotp(true);
        if (!requiresTotp) {
          setNotice(
            loginError.message
              ? translateKnownLoginError(loginError.message)
              : t('pages.login.error.authenticatorCodeRequired'),
          );
          return;
        }
      }
      setError(loginError instanceof Error ? translateKnownLoginError(loginError.message) : t('pages.login.error.loginFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const resetTotpPrompt = () => {
    setRequiresTotp(false);
    setPassword('');
    setTotpCode('');
    setError('');
    setNotice('');
  };

  const handlePasskeyLogin = async () => {
    setError('');
    setNotice('');
    setIsLoading(true);
    try {
      if (!window.isSecureContext || !navigator.credentials) {
        throw new Error(t('pages.login.error.passkeysRequireSecureContext'));
      }

      const optionsResponse = await fetch(apiUrl('/api/auth/webauthn/login/options'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      if (!optionsResponse.ok) throw new Error(t('pages.login.error.failedToStartPasskeyLogin'));
      const options = toPublicKeyCredentialRequestOptions(await optionsResponse.json() as Record<string, unknown>);
      const credential = await navigator.credentials.get({ publicKey: options }) as PublicKeyCredential | null;
      if (!credential) throw new Error(t('pages.login.error.noPasskeyCredential'));

      const verifyResponse = await fetch(apiUrl('/api/auth/webauthn/login/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serializeAuthenticationCredential(credential)),
      });
      if (!verifyResponse.ok) {
        const payload = await verifyResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ? translateKnownLoginError(payload.error) : t('pages.login.error.passkeyAuthenticationFailed'));
      }
      await refresh();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : t('pages.login.error.passkeyAuthenticationFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4 text-gray-100">
      <div className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <img src={assetUrl('/logo.svg')} alt="" className="mx-auto h-14 w-14" />
          <h1 className="mt-4 text-2xl font-bold">{t('pages.login.title')}</h1>
          <p className="mt-1 text-sm text-gray-400">{t('pages.login.subtitle')}</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {notice && !error && (
          <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
            {notice}
          </div>
        )}

        {!passwordLoginDisabled && (
          <form onSubmit={(event) => void handlePasswordLogin(event)} className="space-y-4" noValidate>
            {!requiresTotp ? (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="login-username" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {t('pages.login.username')}
                  </label>
                  <input
                    id="login-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="login-password" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {t('pages.login.password')}
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('pages.login.signingInAs')}</p>
                    <p className="truncate text-sm font-medium text-gray-100">{username}</p>
                  </div>
                  <button
                    type="button"
                    onClick={resetTotpPrompt}
                    disabled={isLoading}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('pages.login.change')}
                  </button>
                </div>
                <label htmlFor="login-totp" className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {t('pages.login.authenticatorCode')}
                </label>
                <input
                  id="login-totp"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" />
              {t('pages.login.signIn')}
            </button>
          </form>
        )}

        {!requiresTotp && (passkeysEnabled || oidcEnabled) && (
          <div className={`${passwordLoginDisabled ? '' : 'mt-4'} space-y-2`}>
            {passkeysEnabled && (
              <button
                type="button"
                onClick={() => void handlePasskeyLogin()}
                disabled={isLoading}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" />
                {t('pages.login.signInWithPasskey')}
              </button>
            )}
            {oidcEnabled && (
              <a
                href={apiUrl('/api/auth/oidc/login')}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-800"
              >
                <ShieldCheck className="h-4 w-4" />
                {t('pages.login.continueWithSso')}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
