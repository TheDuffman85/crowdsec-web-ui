import type { HubAction } from './insightsApi';

/** The cscli line for an action, shown in the confirmation and offered for copying. */
export function hubCommand(action: HubAction): string {
  if (action.action === 'update') return 'cscli hub update';
  if (action.action === 'upgrade-all') return 'cscli hub upgrade';
  return `cscli ${action.type} ${action.action} ${action.name}`;
}
