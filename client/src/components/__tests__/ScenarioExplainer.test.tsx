import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ScenarioExplainer } from '../ScenarioExplainer';

describe('ScenarioExplainer', () => {
  test('shows severity and a plain-English description for a known scenario', () => {
    render(<ScenarioExplainer scenario="crowdsecurity/http-sqli-probing" />);
    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(screen.getByText(/inject code into a website/i)).toBeInTheDocument();
  });

  test('renders nothing for unknown or missing scenarios', () => {
    const { container, rerender } = render(<ScenarioExplainer scenario="acme/custom" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ScenarioExplainer />);
    expect(container).toBeEmptyDOMElement();
  });
});
