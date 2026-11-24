import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExportCsvButton } from '../ExportCsvButton';

const columns = [{ header: 'n', value: (row: { n: number }) => row.n }];

describe('ExportCsvButton', () => {
  const createObjectURL = vi.fn(() => 'blob:csv');
  const revokeObjectURL = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;
  const clickedAnchor = () => clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  test('downloads all pages as one CSV file', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ data: [{ n: page }], pagination: { total_pages: 2 } }));
    render(<ExportCsvButton kind="alerts" columns={columns} fetchPage={fetchPage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export results as CSV' }));

    await waitFor(() => expect(clickedAnchor()).toBeDefined());
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(clickedAnchor()?.download).toMatch(/^crowdsec-alerts-.*\.csv$/);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob.text()).toBe('n\r\n1\r\n2\r\n');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv');
  });

  test('shows an error and does not download when a page fails', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('boom'); });
    render(<ExportCsvButton kind="decisions" columns={columns} fetchPage={fetchPage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export results as CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The export failed. Try again.');
    expect(clickedAnchor()).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Export results as CSV' })).not.toBeDisabled();
  });
});
