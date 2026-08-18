import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Modal } from '../ui/Modal';

function renderModal(onClose: () => void) {
  render(
    <Modal isOpen onClose={onClose} title="Add Decision">
      <input aria-label="IP Address" />
    </Modal>,
  );
  return screen.getByRole('dialog').parentElement!;
}

describe('Modal', () => {
  test('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const backdrop = renderModal(onClose);

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('stays open when a press starts inside the dialog and is released over the backdrop', () => {
    const onClose = vi.fn();
    const backdrop = renderModal(onClose);

    // Selecting text in an input and releasing outside the dialog dispatches
    // the click on the backdrop, which must not close the dialog.
    fireEvent.pointerDown(screen.getByLabelText('IP Address'));
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
  });

  test('closes from a later backdrop click after a press was released over the backdrop', () => {
    const onClose = vi.fn();
    const backdrop = renderModal(onClose);

    fireEvent.pointerDown(screen.getByLabelText('IP Address'));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('does not close when clicking inside the dialog content', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    const input = screen.getByLabelText('IP Address');
    fireEvent.pointerDown(input);
    fireEvent.click(input);

    expect(onClose).not.toHaveBeenCalled();
  });

  test('closes from the close button', () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(screen.getByRole('button'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
