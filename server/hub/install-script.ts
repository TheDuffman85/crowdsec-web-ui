import { HUB_EXEC_SCRIPT, HUB_INSTALL_TEMPLATE, HUB_UNINSTALL_SCRIPT } from './scripts.generated';

export interface InstallScriptOptions {
  /** Where the server being paired reaches this Web UI, without a trailing slash. */
  baseUrl: string;
  token: string;
  /** authorized_keys line of the key the Web UI will connect with. */
  publicKey: string;
  /** Address the Web UI connects from, as seen by the paired server. Empty lets the script work it out. */
  appFrom?: string;
}

const BASE_URL = /^https?:\/\/[A-Za-z0-9.:[\]_-]+(\/[A-Za-z0-9._~/-]*)?$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]+ [A-Za-z0-9._-]*$/;
const FROM = /^[0-9A-Fa-f:.,/*-]*$/;

/** Marker the installer and uninstaller use to find the line they own in authorized_keys. */
export const HUB_KEY_COMMENT = 'crowdsec-web-ui-hub';
export const HUB_UNINSTALL_COMMAND = 'sudo /usr/local/lib/crowdsec-hub/uninstall.sh';

export function isValidPairingFrom(value: string): boolean {
  return FROM.test(value);
}

/** The shell script served at /api/hub/pair/<token>/install.sh. Every value placed in it is checked first. */
export function generateInstallScript(options: InstallScriptOptions): string {
  const appFrom = options.appFrom ?? '';
  if (!BASE_URL.test(options.baseUrl)) throw new Error('The public URL is not valid for the installer');
  if (!TOKEN.test(options.token)) throw new Error('Invalid pairing token');
  if (!PUBLIC_KEY.test(options.publicKey)) throw new Error('Invalid public key');
  if (!FROM.test(appFrom)) throw new Error('Invalid app address');
  return HUB_INSTALL_TEMPLATE
    .replace('__BASE_URL__', options.baseUrl)
    .replace('__TOKEN__', options.token)
    .replace('__PUBLIC_KEY__', options.publicKey)
    .replace('__APP_FROM__', appFrom)
    .replace('__HUB_EXEC_SCRIPT__', () => HUB_EXEC_SCRIPT.trimEnd())
    .replace('__HUB_UNINSTALL_SCRIPT__', () => HUB_UNINSTALL_SCRIPT.trimEnd());
}

export function installCommand(baseUrl: string, token: string): string {
  return `curl -fsSL ${baseUrl}/api/hub/pair/${token}/install.sh | sudo bash`;
}
