import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SmartSummary } from '../SmartSummary';

describe('SmartSummary', () => {
  test('renders the sentence for the numbers it is given', () => {
    const alerts = [...new Array(7).fill(1), ...new Array(7).fill(2)].map((count, index) => ({ date: `d${index}`, fullDate: `d${index}`, label: `d${index}`, count }));
    render(<SmartSummary alerts={alerts} granularity="day" totalAlerts={21} topScenarios={[{ label: 'crowdsecurity/http-probing', count: 21 }]} topCountries={[{ label: 'FR', count: 7, countryCode: 'FR' }]} topIPs={[]} />);
    const summary = screen.getByTestId('smart-summary');
    expect(summary).toHaveTextContent('up 100%');
    expect(summary).toHaveTextContent('crowdsecurity/http-probing caused 100% of alerts.');
    expect(summary).toHaveTextContent('Most attacks came from France (33%).');
    expect(summary).not.toHaveTextContent('busiest');
  });
});
