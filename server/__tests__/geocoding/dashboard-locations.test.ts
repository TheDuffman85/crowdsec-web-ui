import { describe, expect, test } from 'vitest';
import {
  addDashboardAttackLocation,
  DASHBOARD_ATTACK_LOCATION_LIMIT,
  dashboardAttackLocationData,
  type DashboardAttackLocationAccumulator,
} from '../../dashboard-locations';

describe('dashboard attack locations', () => {
  test('aggregates nearby source coordinates and tracks live and simulated counts', () => {
    const locations: DashboardAttackLocationAccumulator = new Map();

    addDashboardAttackLocation(locations, { latitude: 52.52, longitude: 13.405, simulated: false });
    addDashboardAttackLocation(locations, { latitude: 52.51, longitude: 13.41, simulated: true });

    expect(dashboardAttackLocationData(locations)).toEqual([{
      latitude: 52.515,
      longitude: 13.4075,
      count: 2,
      liveCount: 1,
      simulatedCount: 1,
    }]);
  });

  test('keeps a 100,000-alert workload bounded to the marker limit', () => {
    const locations: DashboardAttackLocationAccumulator = new Map();

    for (let index = 0; index < 100_000; index += 1) {
      const bucket = index % 600;
      const latitude = -75 + Math.floor(bucket / 60) * 2;
      const longitude = -170 + (bucket % 60) * 5;
      addDashboardAttackLocation(locations, { latitude, longitude, simulated: index % 10 === 0 });
    }

    const result = dashboardAttackLocationData(locations);
    expect(locations.size).toBe(600);
    expect(result).toHaveLength(DASHBOARD_ATTACK_LOCATION_LIMIT);
    expect(result.every((location) => location.count >= 166)).toBe(true);
  });
});
