import { describe, expect, test } from 'vitest';
import { isSimulatedAlert, isSimulatedDecision, matchesSimulationFilter, parseSimulationFilter } from './simulation';

describe('simulation helpers', () => {
  test('parses supported filters', () => {
    expect(parseSimulationFilter('live')).toBe('live');
    expect(parseSimulationFilter('simulated')).toBe('simulated');
    expect(parseSimulationFilter('anything-else')).toBe('all');
  });

  test('detects simulated decisions and alerts', () => {
    expect(isSimulatedDecision({ simulated: true })).toBe(true);
    expect(isSimulatedDecision({ simulated: false })).toBe(false);
    expect(isSimulatedAlert({ simulated: true, decisions: [] })).toBe(true);
    expect(isSimulatedAlert({ simulated: false, decisions: [{ simulated: true }] })).toBe(true);
    expect(isSimulatedAlert({ simulated: false, decisions: [{ simulated: true }, { simulated: false }] })).toBe(false);
  });

  test('matches live and simulated filters', () => {
    expect(matchesSimulationFilter({ simulated: true }, 'all')).toBe(true);
    expect(matchesSimulationFilter({ simulated: true }, 'simulated')).toBe(true);
    expect(matchesSimulationFilter({ simulated: false }, 'simulated')).toBe(false);
    expect(matchesSimulationFilter({ simulated: false }, 'live')).toBe(true);
  });
});
