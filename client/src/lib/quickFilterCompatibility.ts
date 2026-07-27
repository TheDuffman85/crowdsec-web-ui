import type {
    SearchFacetSelection,
    SearchNode,
} from '../../../shared/search';
import type { FacetField } from '../types';

export type QuickFilterIncompatibilityReason =
    | 'syntax-error'
    | 'broad-match'
    | 'free-text'
    | 'strict-date'
    | 'unsupported-field'
    | 'boolean-logic'
    | 'conflicting-filter';

export type QuickFilterCompatibility =
    | { compatible: true }
    | { compatible: false; reason: QuickFilterIncompatibilityReason };

interface FacetCompatibilityState {
    inclusionFields: Set<string>;
    selections: Map<string, SearchFacetSelection>;
}

export function getQuickFilterCompatibility(
    searchAst: SearchNode | null,
    fields: Iterable<FacetField>,
): QuickFilterCompatibility {
    const supportedFields = new Set<string>(fields);
    supportedFields.add('date');
    supportedFields.add('sim');
    const state: FacetCompatibilityState = {
        inclusionFields: new Set(),
        selections: new Map(),
    };
    const result = inspectAndExpression(searchAst, supportedFields, state);
    if (!result.compatible) return result;

    for (const selection of state.selections.values()) {
        const included = new Set(selection.included);
        if (selection.excluded.some((value) => included.has(value))) {
            return { compatible: false, reason: 'conflicting-filter' };
        }
    }
    const simulation = state.selections.get('sim');
    if (
        simulation
        && [...simulation.included, ...simulation.excluded].some(
            (value) => value !== 'live' && value !== 'simulated',
        )
    ) {
        return { compatible: false, reason: 'conflicting-filter' };
    }
    return { compatible: true };
}

function inspectAndExpression(
    node: SearchNode | null,
    supportedFields: Set<string>,
    state: FacetCompatibilityState,
): QuickFilterCompatibility {
    if (!node) return { compatible: true };
    if (node.kind === 'binary' && node.operator === 'AND') {
        const left = inspectAndExpression(node.left, supportedFields, state);
        return left.compatible
            ? inspectAndExpression(node.right, supportedFields, state)
            : left;
    }
    if (node.kind === 'binary') {
        return inspectInclusionExpression(node, supportedFields, state);
    }
    if (node.kind === 'field') {
        return { compatible: false, reason: 'broad-match' };
    }
    if (node.kind === 'term') {
        return { compatible: false, reason: 'free-text' };
    }
    if (node.kind === 'not') {
        if (node.expression.kind !== 'comparison') {
            return { compatible: false, reason: 'boolean-logic' };
        }
        const comparison = node.expression;
        if (comparison.field === 'date') {
            return { compatible: false, reason: 'boolean-logic' };
        }
        if (comparison.operator !== '=' && comparison.operator !== '<>') {
            return { compatible: false, reason: 'boolean-logic' };
        }
        return recordFacetValue(
            comparison.field,
            comparison.value,
            comparison.operator === '=' ? 'excluded' : 'included',
            supportedFields,
            state,
        );
    }
    return inspectComparison(node, supportedFields, state);
}

function inspectComparison(
    node: Extract<SearchNode, { kind: 'comparison' }>,
    supportedFields: Set<string>,
    state: FacetCompatibilityState,
): QuickFilterCompatibility {
    if (!supportedFields.has(node.field)) {
        return { compatible: false, reason: 'unsupported-field' };
    }
    if (node.field === 'date') {
        return node.operator === '>=' || node.operator === '<='
            ? { compatible: true }
            : { compatible: false, reason: 'strict-date' };
    }
    if (node.operator !== '=' && node.operator !== '<>') {
        return { compatible: false, reason: 'boolean-logic' };
    }
    return recordFacetValue(
        node.field,
        node.value,
        node.operator === '=' ? 'included' : 'excluded',
        supportedFields,
        state,
    );
}

function inspectInclusionExpression(
    node: SearchNode,
    supportedFields: Set<string>,
    state: FacetCompatibilityState,
): QuickFilterCompatibility {
    const comparisons: Array<Extract<SearchNode, { kind: 'comparison' }>> = [];
    const collect = (candidate: SearchNode): boolean => {
        if (candidate.kind === 'binary' && candidate.operator === 'OR') {
            return collect(candidate.left) && collect(candidate.right);
        }
        if (candidate.kind !== 'comparison' || candidate.operator !== '=') return false;
        comparisons.push(candidate);
        return true;
    };

    if (!collect(node) || comparisons.length === 0) {
        return { compatible: false, reason: 'boolean-logic' };
    }
    const field = comparisons[0].field;
    if (
        field === 'date'
        || comparisons.some((comparison) => comparison.field !== field)
    ) {
        return { compatible: false, reason: 'boolean-logic' };
    }
    if (!supportedFields.has(field)) {
        return { compatible: false, reason: 'unsupported-field' };
    }
    if (state.inclusionFields.has(field)) {
        return { compatible: false, reason: 'conflicting-filter' };
    }
    state.inclusionFields.add(field);

    for (const comparison of comparisons) {
        const result = recordFacetValue(
            field,
            comparison.value,
            'included',
            supportedFields,
            state,
            false,
        );
        if (!result.compatible) return result;
    }
    return { compatible: true };
}

function recordFacetValue(
    field: string,
    value: string,
    kind: keyof SearchFacetSelection,
    supportedFields: Set<string>,
    state: FacetCompatibilityState,
    trackInclusionClause = true,
): QuickFilterCompatibility {
    if (!supportedFields.has(field)) {
        return { compatible: false, reason: 'unsupported-field' };
    }
    if (field === 'date') {
        return { compatible: false, reason: 'boolean-logic' };
    }
    if (kind === 'included' && trackInclusionClause) {
        if (state.inclusionFields.has(field)) {
            return { compatible: false, reason: 'conflicting-filter' };
        }
        state.inclusionFields.add(field);
    }
    const selection = state.selections.get(field) ?? { included: [], excluded: [] };
    if (!selection[kind].includes(value)) selection[kind].push(value);
    state.selections.set(field, selection);
    return { compatible: true };
}
