import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SidebarResizeHandle } from '../SidebarResizeHandle';

function renderHandle() {
  const props = {
    width: 360,
    minWidth: 280,
    maxWidth: 520,
    onResize: vi.fn(),
    onReset: vi.fn(),
    onResizingChange: vi.fn(),
  };
  render(<SidebarResizeHandle {...props} />);
  return { props, handle: screen.getByRole('separator', { name: 'Resize sidebar' }) };
}

describe('SidebarResizeHandle', () => {
  test('reports its width and resizes from the keyboard', () => {
    const { props, handle } = renderHandle();

    expect(handle).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'Enter' });

    expect(props.onResize.mock.calls).toEqual([[376], [296], [280], [520]]);
  });

  test('follows the pointer only while dragging and resets on double click', () => {
    const { props, handle } = renderHandle();
    // jsdom does not implement pointer capture.
    const captured = new Set<number>();
    handle.setPointerCapture = (id) => { captured.add(id); };
    handle.hasPointerCapture = (id) => captured.has(id);
    handle.releasePointerCapture = (id) => { captured.delete(id); };

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 });
    expect(props.onResize).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450 });

    expect(props.onResize.mock.calls).toEqual([[420]]);
    expect(props.onResizingChange.mock.calls).toEqual([[true], [false]]);

    fireEvent.doubleClick(handle);
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });
});
