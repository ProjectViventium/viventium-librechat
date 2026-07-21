/**
 * === VIVENTIUM START ===
 * Regression: Escape dismisses a dialog after its combobox closes, but not while it is open.
 * === VIVENTIUM END ===
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from './OriginalDialog';

describe('OGDialog keyboard dismissal', () => {
  it('closes on Escape when focus is on a closed combobox', async () => {
    const onOpenChange = jest.fn();

    render(
      <OGDialog open onOpenChange={onOpenChange}>
        <OGDialogContent>
          <OGDialogTitle>Set API Key</OGDialogTitle>
          <button
            type="button"
            role="combobox"
            aria-controls="closed-expiry-options"
            aria-expanded="false"
          >
            Expires in 12 hours
          </button>
          <div id="closed-expiry-options" role="listbox" hidden />
        </OGDialogContent>
      </OGDialog>,
    );

    screen.getByRole('combobox').focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('lets an open combobox consume the first Escape key', () => {
    const onOpenChange = jest.fn();

    render(
      <OGDialog open onOpenChange={onOpenChange}>
        <OGDialogContent>
          <OGDialogTitle>Set API Key</OGDialogTitle>
          <button
            type="button"
            role="combobox"
            aria-controls="open-expiry-options"
            aria-expanded="true"
          >
            Expires in 12 hours
          </button>
          <div id="open-expiry-options" role="listbox" />
        </OGDialogContent>
      </OGDialog>,
    );

    screen.getByRole('combobox').focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
