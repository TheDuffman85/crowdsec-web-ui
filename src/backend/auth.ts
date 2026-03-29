export interface PasswordCrowdsecAuthConfig {
  mode: 'password';
  user: string;
  password: string;
}

export interface MtlsCrowdsecAuthConfig {
  mode: 'mtls';
  certPath: string;
  keyPath: string;
  caCertPath?: string;
}

export interface NoCrowdsecAuthConfig {
  mode: 'none';
}

export type CrowdsecAuthConfig =
  | PasswordCrowdsecAuthConfig
  | MtlsCrowdsecAuthConfig
  | NoCrowdsecAuthConfig;

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function createCrowdsecAuthConfig(env: NodeJS.ProcessEnv = process.env): CrowdsecAuthConfig {
  const user = normalizeEnvValue(env.CROWDSEC_USER);
  const password = normalizeEnvValue(env.CROWDSEC_PASSWORD);
  const certPath = normalizeEnvValue(env.CROWDSEC_TLS_CERT_PATH);
  const keyPath = normalizeEnvValue(env.CROWDSEC_TLS_KEY_PATH);
  const caCertPath = normalizeEnvValue(env.CROWDSEC_TLS_CA_CERT_PATH);

  const hasPasswordAuth = Boolean(user && password);
  const hasPasswordAuthInput = Boolean(user || password);
  const hasMtlsAuth = Boolean(certPath && keyPath);
  const hasMtlsAuthInput = Boolean(certPath || keyPath || caCertPath);

  if (hasPasswordAuth && hasMtlsAuth) {
    throw new Error(
      'CrowdSec authentication is misconfigured: choose either CROWDSEC_USER/CROWDSEC_PASSWORD or CROWDSEC_TLS_CERT_PATH/CROWDSEC_TLS_KEY_PATH, but not both.',
    );
  }

  if (hasPasswordAuthInput && !hasPasswordAuth) {
    throw new Error('CrowdSec password authentication requires both CROWDSEC_USER and CROWDSEC_PASSWORD.');
  }

  if (hasMtlsAuthInput && !hasMtlsAuth) {
    throw new Error('CrowdSec mTLS authentication requires both CROWDSEC_TLS_CERT_PATH and CROWDSEC_TLS_KEY_PATH.');
  }

  if (hasPasswordAuth) {
    return {
      mode: 'password',
      user: user!,
      password: password!,
    };
  }

  if (hasMtlsAuth) {
    return {
      mode: 'mtls',
      certPath: certPath!,
      keyPath: keyPath!,
      caCertPath,
    };
  }

  return { mode: 'none' };
}

export function hasCrowdsecAuthConfig(auth: CrowdsecAuthConfig): boolean {
  return auth.mode !== 'none';
}
