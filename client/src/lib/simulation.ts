import type { AlertRecord, SimulationFilter, SlimAlert, SlimDecision, StatsAlert, StatsDecision } from '../types';

type AlertLike = Pick<AlertRecord | SlimAlert | StatsAlert, 'simulated'> & {
  decisions?: Array<Pick<SlimDecision, 'simulated'>>;
};

type DecisionLike = Pick<SlimDecision | StatsDecision, 'simulated'>;

export function parseSimulationFilter(value: string | null | undefined): SimulationFilter {
  if (value === 'live' || value === 'simulated') {
    return value;
  }

  return 'all';
}

export function isSimulatedDecision(decision: DecisionLike | null | undefined): boolean {
  return decision?.simulated === true;
}

export function isSimulatedAlert(alert: AlertLike | null | undefined): boolean {
  if (!alert) {
    return false;
  }

  if (alert.simulated === true) {
    return true;
  }

  return Array.isArray(alert.decisions) && alert.decisions.length > 0 && alert.decisions.every((decision) => isSimulatedDecision(decision));
}

export function matchesSimulationFilter(item: { simulated?: boolean }, filter: SimulationFilter): boolean {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'simulated') {
    return item.simulated === true;
  }

  return item.simulated !== true;
}
