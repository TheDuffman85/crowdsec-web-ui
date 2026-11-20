/** README section on `trusted_ips`, which CrowdSec requires for alert deletion and allowlist changes. */
export function trustedIpsHelpLink(): string {
    const repoUrl = import.meta.env.VITE_REPO_URL || 'https://github.com/TheDuffman85/crowdsec-web-ui';
    return `${repoUrl}#trusted-ips-for-delete-operations-optional`;
}
