export const AUTH_SESSION_INVALIDATED_EVENT = 'crowdsec-auth-session-invalidated';

interface SessionFetchOptions {
  ignoredUnauthorizedErrors?: readonly string[];
}

export async function sessionFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: SessionFetchOptions,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    const payload = options?.ignoredUnauthorizedErrors
      ? await response.clone().json().catch(() => null) as { error?: string } | null
      : null;
    const isExpectedCredentialError = (
      payload?.error
      && options?.ignoredUnauthorizedErrors?.includes(payload.error)
    );
    if (!isExpectedCredentialError) {
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    }
  }
  return response;
}
