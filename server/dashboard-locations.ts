import type { DashboardAttackLocationDatum } from '../shared/contracts';

export interface DashboardAttackLocationSummary {
  latitudeSum: number;
  longitudeSum: number;
  count: number;
  liveCount: number;
  simulatedCount: number;
}

export type DashboardAttackLocationAccumulator = Map<string, DashboardAttackLocationSummary>;

// A quarter degree is sub-pixel at the dashboard's default world-map scale,
// while collapsing city-level IP geolocation duplicates before they reach the browser.
const LOCATION_GRID_DEGREES = 0.25;
// Bound both the response payload and the number of concurrent CSS animations.
export const DASHBOARD_ATTACK_LOCATION_LIMIT = 500;

export function addDashboardAttackLocation(
  locations: DashboardAttackLocationAccumulator,
  alert: { latitude?: number; longitude?: number; simulated: boolean },
): void {
  if (alert.latitude === undefined || alert.longitude === undefined) return;

  const latitudeBucket = Math.round(alert.latitude / LOCATION_GRID_DEGREES);
  const longitudeBucket = Math.round(alert.longitude / LOCATION_GRID_DEGREES);
  const key = `${latitudeBucket}:${longitudeBucket}`;
  const current = locations.get(key) || {
    latitudeSum: 0,
    longitudeSum: 0,
    count: 0,
    liveCount: 0,
    simulatedCount: 0,
  };

  current.latitudeSum += alert.latitude;
  current.longitudeSum += alert.longitude;
  current.count += 1;
  if (alert.simulated) {
    current.simulatedCount += 1;
  } else {
    current.liveCount += 1;
  }
  locations.set(key, current);
}

export function dashboardAttackLocationData(
  locations: DashboardAttackLocationAccumulator,
): DashboardAttackLocationDatum[] {
  return Array.from(locations.entries())
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, DASHBOARD_ATTACK_LOCATION_LIMIT)
    .map(([, summary]) => ({
      latitude: Number((summary.latitudeSum / summary.count).toFixed(4)),
      longitude: Number((summary.longitudeSum / summary.count).toFixed(4)),
      count: summary.count,
      liveCount: summary.liveCount,
      simulatedCount: summary.simulatedCount,
    }));
}
