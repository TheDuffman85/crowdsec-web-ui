import { describe, expect, test } from 'vitest';
import { formatAlertMessage, MANUAL_DECISION_MESSAGE_PREFIX } from '../../../../shared/contracts';

describe('formatAlertMessage', () => {
    test('strips the prefix the Web UI adds to manual decisions', () => {
        expect(formatAlertMessage(`${MANUAL_DECISION_MESSAGE_PREFIX}: noisy scanner`)).toBe('noisy scanner');
    });

    test('keeps other alert messages unchanged apart from surrounding whitespace', () => {
        expect(formatAlertMessage("  Ip 1.2.3.4 performed 'crowdsecurity/ssh-bf' (6 events over 2s)  "))
            .toBe("Ip 1.2.3.4 performed 'crowdsecurity/ssh-bf' (6 events over 2s)");
        expect(formatAlertMessage('manual ban from cscli')).toBe('manual ban from cscli');
    });

    test('returns undefined when there is no message to show', () => {
        expect(formatAlertMessage(undefined)).toBeUndefined();
        expect(formatAlertMessage(null)).toBeUndefined();
        expect(formatAlertMessage('   ')).toBeUndefined();
        expect(formatAlertMessage(`${MANUAL_DECISION_MESSAGE_PREFIX}:   `)).toBeUndefined();
    });
});
