import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

// Helper component that triggers toasts
function ToastTrigger({ type, message }: { type: 'success' | 'error' | 'info' | 'warning'; message: string }) {
  const { toast } = useToast();
  return <button onClick={() => toast(type, message)}>Show Toast</button>;
}

describe('ToastProvider + useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders children', () => {
    render(
      <ToastProvider>
        <div>App content</div>
      </ToastProvider>
    );
    expect(screen.getByText('App content')).toBeInTheDocument();
  });

  it('shows a success toast when triggered', () => {
    render(
      <ToastProvider>
        <ToastTrigger type="success" message="Saved!" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Toast'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });

  it('shows an error toast with alert role', () => {
    render(
      <ToastProvider>
        <ToastTrigger type="error" message="Something failed" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Toast'));
    const toast = screen.getByRole('alert');
    expect(toast).toBeInTheDocument();
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('shows info toast with status role', () => {
    render(
      <ToastProvider>
        <ToastTrigger type="info" message="FYI info" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Toast'));
    expect(screen.getByText('FYI info')).toBeInTheDocument();
    // The individual info toast should have role="status"
    const toastEl = screen.getByText('FYI info').closest('[role="status"][aria-live]');
    expect(toastEl).toBeInTheDocument();
  });

  it('removes toast after 4 seconds', () => {
    render(
      <ToastProvider>
        <ToastTrigger type="success" message="Will vanish" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Toast'));
    expect(screen.getByText('Will vanish')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText('Will vanish')).not.toBeInTheDocument();
  });

  it('removes toast when dismiss button is clicked', () => {
    render(
      <ToastProvider>
        <ToastTrigger type="success" message="Dismiss me" />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Show Toast'));
    expect(screen.getByText('Dismiss me')).toBeInTheDocument();

    const dismissBtn = screen.getByLabelText('Dismiss notification');
    fireEvent.click(dismissBtn);
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });

  it('can show multiple toasts simultaneously', () => {
    function MultiTrigger() {
      const { toast } = useToast();
      return (
        <>
          <button onClick={() => toast('success', 'First')}>Toast 1</button>
          <button onClick={() => toast('error', 'Second')}>Toast 2</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <MultiTrigger />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Toast 1'));
    fireEvent.click(screen.getByText('Toast 2'));

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('applies correct background class for each toast type', () => {
    function TypeTrigger() {
      const { toast } = useToast();
      return (
        <>
          <button onClick={() => toast('success', 'msg-success')}>Btn S</button>
          <button onClick={() => toast('error', 'msg-error')}>Btn E</button>
          <button onClick={() => toast('info', 'msg-info')}>Btn I</button>
          <button onClick={() => toast('warning', 'msg-warn')}>Btn W</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <TypeTrigger />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('Btn S'));
    const successToast = screen.getByText('msg-success').closest('[class*="bg-emerald-50"]');
    expect(successToast).toBeInTheDocument();

    fireEvent.click(screen.getByText('Btn E'));
    const errorToast = screen.getByText('msg-error').closest('[class*="bg-red-50"]');
    expect(errorToast).toBeInTheDocument();

    fireEvent.click(screen.getByText('Btn I'));
    const infoToast = screen.getByText('msg-info').closest('[class*="bg-blue-50"]');
    expect(infoToast).toBeInTheDocument();

    fireEvent.click(screen.getByText('Btn W'));
    const warnToast = screen.getByText('msg-warn').closest('[class*="bg-amber-50"]');
    expect(warnToast).toBeInTheDocument();
  });
});
