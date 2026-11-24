import { HUB_ITEM_TYPES, type HubItemType } from './executor';

export interface HubItem {
  type: HubItemType;
  name: string;
  version: string;
  description: string;
  installed: boolean;
  /** An installed copy is older than the hub's. */
  upgradable: boolean;
  /** A file written by hand rather than installed from the hub, so it cannot be managed here. */
  local: boolean;
  /** The installed copy was edited and an upgrade would overwrite the changes. */
  tainted: boolean;
}

export type HubCatalog = Record<HubItemType, HubItem[]>;

/** Turns the JSON of `cscli hub list -a -o json` into a compact catalog. */
export function parseHubCatalog(stdout: string): HubCatalog {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unexpected hub list output');
  const record = parsed as Record<string, unknown>;
  const catalog = {} as HubCatalog;
  for (const type of HUB_ITEM_TYPES) {
    const rows = Array.isArray(record[type]) ? record[type] as Array<Record<string, unknown>> : [];
    catalog[type] = rows
      .filter((row) => typeof row.name === 'string' && row.name)
      .map((row) => {
        const status = typeof row.status === 'string' ? row.status : '';
        const flags = status.split(',').map((flag) => flag.trim());
        return {
          type,
          name: row.name as string,
          version: typeof row.local_version === 'string' ? row.local_version : '',
          description: typeof row.description === 'string' ? row.description.slice(0, 300) : '',
          installed: flags.includes('enabled'),
          upgradable: flags.includes('enabled') && flags.includes('update-available'),
          local: flags.includes('local'),
          tainted: flags.includes('tainted'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return catalog;
}
