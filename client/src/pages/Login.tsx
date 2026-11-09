import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../lib/basePath';
import { claimOidcAutoLoginRetry, hasOidcAutoLoginRetried, isOidcAutoLoginSuppressed } from '../lib/oidcAutoLogin';
import { AppLogo } from '../components/AppLogo';
import { useBranding } from '../contexts/useBranding';
import { useI18n } from '../lib/i18n';
import {
  serializeAuthenticationCredential,
  toPublicKeyCredentialRequestOptions,
} from '../lib/webauthn';

// Why an SSO sign-in sent the browser back to the login page; set by the OIDC callback.
type OidcLoginError = 'expired' | 'failed' | 'denied' | 'unavailable';

function readOidcLoginError(value: string | null): OidcLoginError | null {
  return value === 'expired' || value === 'failed' || value === 'denied' || value === 'unavailable' ? value : null;
}

export function Login() {
  const { authEnabled, authenticated, login, oidcAutoLogin, oidcEnabled, passwordLoginDisabled, passkeysEnabled, refresh } = useAuth();
  const { t } = useI18n();
  const { appName } = useBranding();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [oidcError] = useState(() => readOidcLoginError(searchParams.get('oidcError')));
  // ?local=1 keeps the login page reachable, for example to sign in with a passkey. After a failed
  // SSO sign-in only an expired one starts again on its own, and only once; any other failure would
  // send the user straight back into it.
  const [redirectingToSso, setRedirectingToSso] = useState(() => (
    authEnabled && !authenticated && oidcAutoLogin && searchParams.get('local') !== '1' && !isOidcAutoLoginSuppressed()
    && (!oidcError || (oidcError === 'expired' && !hasOidcAutoLoginRetried()))
  ));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Kept as a reason, not text, so it follows a language preference that loads after the first render.
  const [oidcMessage, setOidcMessage] = useState(() => (redirectingToSso ? null : oidcError));
  const [isLoading, setIsLoading] = useState(false);
  // Claimed once per page, so running the effect again cannot claim a second time.
  const retryClaim = useRef<boolean | null>(null);

  useEffect(() => {
    if (!redirectingToSso) return;
    if (oidcError) {
      retryClaim.current ??= claimOidcAutoLoginRetry();
      if (!retryClaim.current) {
        setRedirectingToSso(false);
        setOidcMessage(oidcError);
        return;
      }
    }
    window.location.replace(apiUrl('/api/auth/oidc/login'));
  }, [oidcError, redirectingToSso]);

  // The reason is shown once; a reload must not show it again.
  useEffect(() => {
    if (!oidcError || redirectingToSso) return;
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete('oidcError');
      return next;
    }, { replace: true });
  }, [oidcError, redirectingToSso, setSearchParams]);

  if (!authEnabled || authenticated) {
    return <Navigate to="/" replace />;
  }

  const shownError = error || (oidcMessage && oidcMessage !== 'expired' ? t(`pages.login.oidcError.${oidcMessage}`) : '');
  const shownNotice = notice || (oidcMessage === 'expired' ? t('pages.login.oidcError.expired') : '');

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
      case 'This passkey belongs to an OIDC-only account. Sign in with SSO instead.':
        return t('pages.login.error.oidcOnlyPasskey');
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
    setOidcMessage(null);
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
    setOidcMessage(null);
  };

  const handlePasskeyLogin = async () => {
    setError('');
    setNotice('');
    setOidcMessage(null);
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
          <AppLogo className="mx-auto h-14 w-14" />
          <h1 className="mt-4 text-2xl font-bold">{t('pages.login.title')}</h1>
          <p className="mt-1 break-words text-sm text-gray-400">{t('pages.login.subtitle', { appName })}</p>
        </div>

        {shownError && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {shownError}
          </div>
        )}

        {redirectingToSso && (
          <p role="status" className="mb-4 text-center text-sm text-gray-400">
            {t('pages.login.redirectingToSso')}
          </p>
        )}

        {shownNotice && !shownError && (
          <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
            {shownNotice}
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
