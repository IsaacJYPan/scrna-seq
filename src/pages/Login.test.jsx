import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';
import auth from '../auth';

vi.mock('../auth', () => ({
  default: {
    registrationPolicy: vi.fn(),
    signup: vi.fn(),
    login: vi.fn(),
    startDemoGuest: vi.fn(),
  },
}));

describe('Login registration policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides network signup when accounts are operator-managed', async () => {
    auth.registrationPolicy.mockResolvedValue({ registrationEnabled: false });
    render(<Login onLogin={vi.fn()} />);

    expect(await screen.findByText(/accounts are provisioned by your deployment administrator/i))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open workbench/i })).toBeInTheDocument();
  });

  it('offers development signup only when the server policy enables it', async () => {
    auth.registrationPolicy.mockResolvedValue({ registrationEnabled: true });
    render(<Login onLogin={vi.fn()} />);

    const signup = await screen.findByRole('button', { name: 'Sign Up' });
    fireEvent.click(signup);
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('starts an ephemeral curated workspace in public demo mode', async () => {
    auth.registrationPolicy.mockResolvedValue({ registrationEnabled: false, demoMode: true });
    auth.startDemoGuest.mockResolvedValue({ id: 7, email: 'guest@demo.invalid', displayName: 'Demo Guest' });
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.click(await screen.findByRole('button', { name: /start temporary demo/i }));
    await waitFor(() => expect(auth.startDemoGuest).toHaveBeenCalledTimes(1));
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    expect(screen.getByText(/uploads and expert r are disabled/i)).toBeInTheDocument();
  });

  it('fails closed when the policy probe is unavailable', async () => {
    auth.registrationPolicy.mockRejectedValue(new Error('network down'));
    render(<Login onLogin={vi.fn()} />);

    expect(await screen.findByText(/accounts are provisioned/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
  });

  it('shows a logout warning after an expired cookie is cleared locally', async () => {
    auth.registrationPolicy.mockResolvedValue({ registrationEnabled: false });
    render(<Login onLogin={vi.fn()} notice="Your session had already expired. Local session data was cleared." />);

    expect(await screen.findByRole('status')).toHaveTextContent(/session had already expired/i);
  });
});
