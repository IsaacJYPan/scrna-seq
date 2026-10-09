import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DetailsPopover from './DetailsPopover';

it('keeps an anchored panel outside native disclosure content and repeatedly opens it after a close action', () => {
  const action = vi.fn();
  render(<DetailsPopover label="Details"><p>Visible details</p><button data-close-popover onClick={action}>Open another panel</button></DetailsPopover>);
  const opener = screen.getByText('Details'), content = screen.getByText('Visible details');
  expect(content).not.toBeVisible(); expect(content.closest('details')).toBeNull();
  fireEvent.click(opener); expect(content).toBeVisible(); expect(opener.closest('details').open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open another panel' }));
  expect(action).toHaveBeenCalledOnce(); expect(content).not.toBeVisible(); expect(opener).toHaveFocus();
  fireEvent.click(opener); expect(content).toBeVisible(); fireEvent.click(opener); expect(content).not.toBeVisible();
});

it('keeps ordinary panel interactions open, dismisses on outside pointerdown and returns focus on Escape', () => {
  render(<DetailsPopover label="Details"><button>Inspect details</button></DetailsPopover>);
  const opener = screen.getByText('Details'); fireEvent.click(opener);
  const inspect = screen.getByRole('button', { name: 'Inspect details' });
  fireEvent.pointerDown(inspect); fireEvent.click(inspect); expect(inspect).toBeVisible();
  fireEvent.pointerDown(document.body); expect(inspect).not.toBeVisible();
  fireEvent.click(opener); inspect.focus(); fireEvent.keyDown(inspect, { key: 'Escape' });
  expect(inspect).not.toBeVisible(); expect(opener).toHaveFocus();
});

it('hands keyboard focus into the portaled controls and continues after the opener without trapping it', () => {
  render(<><DetailsPopover label="Details"><button disabled>Unavailable action</button><button>First action</button><button>Last action</button></DetailsPopover><button style={{ display: 'none' }}>Hidden action</button><button className="hidden md:block">After details</button></>);
  const opener = screen.getByText('Details'); opener.focus(); fireEvent.click(opener);
  fireEvent.keyDown(opener, { key: 'Tab' }); expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true }); expect(opener).toHaveFocus();
  screen.getByRole('button', { name: 'Last action' }).focus(); fireEvent.keyDown(document.activeElement, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'After details' })).toHaveFocus(); expect(opener.closest('details').open).toBe(false);
});
