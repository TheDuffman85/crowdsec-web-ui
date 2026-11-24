import type { HubItemType } from './executor';

export interface HubProfile {
  id: string;
  items: Array<{ type: HubItemType; name: string }>;
}

/** Starting points an administrator can apply to a server. They are never applied unless asked for. */
export const HUB_PROFILES: readonly HubProfile[] = [
  {
    id: 'web',
    items: [
      { type: 'collections', name: 'crowdsecurity/nginx' },
      { type: 'collections', name: 'crowdsecurity/traefik' },
      { type: 'collections', name: 'crowdsecurity/wordpress' },
      { type: 'collections', name: 'crowdsecurity/base-http-scenarios' },
    ],
  },
  {
    id: 'linux',
    items: [
      { type: 'collections', name: 'crowdsecurity/linux' },
      { type: 'collections', name: 'crowdsecurity/sshd' },
    ],
  },
];

export function findProfile(id: unknown): HubProfile | null {
  return HUB_PROFILES.find((profile) => profile.id === id) ?? null;
}
