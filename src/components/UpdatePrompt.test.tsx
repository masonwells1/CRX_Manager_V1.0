import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { updateServiceWorker } = vi.hoisted(() => ({
  updateServiceWorker: vi.fn(),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [true],
    updateServiceWorker,
  }),
}));

import UpdatePrompt from './UpdatePrompt';

describe('UpdatePrompt', () => {
  it('shows a prominent update action above the mobile bottom navigation', async () => {
    window.innerWidth = 375;
    render(<UpdatePrompt />);

    const updateButton = await screen.findByRole('button', { name: 'Update now' });
    const prompt = screen.getByTestId('update-prompt');

    expect(updateButton).toHaveClass('min-h-11', 'bg-crx-green');
    expect(prompt).toHaveClass(
      'bottom-[calc(4.5rem+env(safe-area-inset-bottom)+0.75rem)]',
      'md:bottom-4'
    );

    fireEvent.click(updateButton);
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });
});
