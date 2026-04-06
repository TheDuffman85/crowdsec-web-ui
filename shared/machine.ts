import type { AlertRecord } from './contracts';

type MachineFields = Pick<AlertRecord, 'machine_id' | 'machine_alias'>;
const IGNORED_MACHINE_VALUES = new Set(['n/a', 'na', 'unknown']);

function normalizeMachineValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (IGNORED_MACHINE_VALUES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

export function resolveMachineName(machine: MachineFields | null | undefined): string | undefined {
  return normalizeMachineValue(machine?.machine_alias) || normalizeMachineValue(machine?.machine_id);
}

export function normalizeMachineId(machineId: string | undefined): string | undefined {
  return normalizeMachineValue(machineId);
}
