import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { CountryFlag } from '../CountryFlag';

describe('CountryFlag', () => {
  test('normalizes the country code and renders the matching SVG flag class', () => {
    render(<CountryFlag code=" de " className="custom-class" />);

    const flag = screen.getByRole('img', { name: 'DE' });
    expect(flag).toHaveClass('fi', 'fi-de', 'custom-class');
    expect(flag).toHaveAttribute('title', 'DE');
    expect(flag).toBeEmptyDOMElement();
  });

  test.each([undefined, null, '', 'D', 'DEU', 'D1'])(
    'renders nothing for invalid code %s',
    (code) => {
      const { container } = render(<CountryFlag code={code} />);

      expect(container).toBeEmptyDOMElement();
    },
  );
});
