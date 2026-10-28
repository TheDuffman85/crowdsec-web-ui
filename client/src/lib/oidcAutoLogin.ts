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
