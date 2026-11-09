// After a logout, the login page must not send the user straight back to the
// identity provider. The flag lives for the tab and clears on the next sign-in.
const OIDC_AUTO_LOGIN_SUPPRESSED_KEY = 'crowdsec-web-ui:oidc-auto-login-suppressed';

export function isOidcAutoLoginSuppressed(): boolean {
  try {
    return sessionStorage.getItem(OIDC_AUTO_LOGIN_SUPPRESSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setOidcAutoLoginSuppressed(suppressed: boolean): void {
  try {
    if (suppressed) {
      sessionStorage.setItem(OIDC_AUTO_LOGIN_SUPPRESSED_KEY, 'true');
    } else {
      sessionStorage.removeItem(OIDC_AUTO_LOGIN_SUPPRESSED_KEY);
    }
  } catch {
    // Storage can be unavailable; auto-login then simply is not suppressed.
  }
}

// A sign-in that returns without its login transaction starts again once on its own. A second
// one waits for the user, so a provider or proxy that loses the transaction cannot cause a loop.
const OIDC_AUTO_LOGIN_RETRIED_KEY = 'crowdsec-web-ui:oidc-auto-login-retried';

export function hasOidcAutoLoginRetried(): boolean {
  try {
    return sessionStorage.getItem(OIDC_AUTO_LOGIN_RETRIED_KEY) === 'true';
  } catch {
    // Without storage the retry cannot be counted, so it is treated as used.
    return true;
  }
}

// Uses up the one automatic retry. It is only granted once the marker is stored and reads back,
// so storage that refuses writes cannot let every expired sign-in start again.
export function claimOidcAutoLoginRetry(): boolean {
  if (hasOidcAutoLoginRetried()) return false;
  setOidcAutoLoginRetried(true);
  return hasOidcAutoLoginRetried();
}

export function setOidcAutoLoginRetried(retried: boolean): void {
  try {
    if (retried) {
      sessionStorage.setItem(OIDC_AUTO_LOGIN_RETRIED_KEY, 'true');
    } else {
      sessionStorage.removeItem(OIDC_AUTO_LOGIN_RETRIED_KEY);
    }
  } catch {
    // Storage can be unavailable; the retry then counts as used.
  }
}
