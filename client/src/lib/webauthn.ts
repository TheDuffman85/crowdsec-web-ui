export function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toPublicKeyCredentialRequestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge as string),
    allowCredentials: (options.allowCredentials as Array<{ id: string; type: string; transports?: AuthenticatorTransport[] }> | undefined)?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  } as PublicKeyCredentialRequestOptions;
}

export function toPublicKeyCredentialCreationOptions(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge as string),
    user: {
      ...(options.user as PublicKeyCredentialUserEntity),
      id: base64urlToBuffer((options.user as { id: string }).id),
    },
    excludeCredentials: (options.excludeCredentials as Array<{ id: string; type: string; transports?: AuthenticatorTransport[] }> | undefined)?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  } as PublicKeyCredentialCreationOptions;
}

export function serializeRegistrationCredential(credential: PublicKeyCredential, name?: string | null): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    name,
    response: {
      attestationObject: bufferToBase64url(response.attestationObject),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  };
}

export function serializeAuthenticationCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bufferToBase64url(response.authenticatorData),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
  };
}
