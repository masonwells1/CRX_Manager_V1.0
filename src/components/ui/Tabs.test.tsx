import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Tabs, { type TabItem } from './Tabs';

const tabs: TabItem[] = [
  { key: 'inventory', label: 'Inventory', content: <p>Inventory content</p>, count: 12 },
  { key: 'forecast', label: 'Forecast', content: <p>Forecast content</p>, count: 0 },
  { key: 'orders', label: 'Orders', content: <p>Orders content</p> },
];

function ControlledTabs() {
  const [activeKey, setActiveKey] = useState('inventory');

  return (
    <Tabs
      tabs={tabs}
      activeKey={activeKey}
      onChange={setActiveKey}
      ariaLabel="Inventory views"
    />
  );
}

describe('Tabs', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  });

  it('renders an accessible tab list and the active panel', () => {
    render(<ControlledTabs />);

    expect(screen.getByRole('tablist', { name: 'Inventory views' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Forecast/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Inventory content');
    expect(screen.queryByText('Forecast content')).not.toBeInTheDocument();
  });

  it('switches the selected tab and panel when clicked', () => {
    render(<ControlledTabs />);

    fireEvent.click(screen.getByRole('tab', { name: /Forecast/ }));

    expect(screen.getByRole('tab', { name: /Forecast/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Forecast content');
    expect(screen.queryByText('Inventory content')).not.toBeInTheDocument();
  });

  it('supports arrow keys plus Home and End with wrapping navigation', () => {
    render(<ControlledTabs />);

    const inventoryTab = screen.getByRole('tab', { name: /Inventory/ });
    inventoryTab.focus();

    fireEvent.keyDown(inventoryTab, { key: 'ArrowRight' });
    const forecastTab = screen.getByRole('tab', { name: /Forecast/ });
    expect(forecastTab).toHaveFocus();
    expect(forecastTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(forecastTab, { key: 'End' });
    const ordersTab = screen.getByRole('tab', { name: 'Orders' });
    expect(ordersTab).toHaveFocus();
    expect(ordersTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(ordersTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: /Inventory/ }), { key: 'End' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Orders' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Inventory content');

    fireEvent.keyDown(screen.getByRole('tab', { name: /Inventory/ }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Orders' })).toHaveFocus();
  });

  it('renders optional count badges, including zero counts', () => {
    render(<ControlledTabs />);

    expect(within(screen.getByRole('tab', { name: /Inventory/ })).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Forecast/ })).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: 'Orders' })).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('keeps mobile tabs on one touch-scrollable row with an edge-fade hint', () => {
    render(<ControlledTabs />);

    const tabList = screen.getByRole('tablist', { name: 'Inventory views' });
    expect(tabList).toHaveClass('flex-nowrap', 'overflow-x-auto', '[-webkit-overflow-scrolling:touch]');
    expect(tabList.parentElement).toHaveClass('relative');
    expect(tabList.parentElement?.querySelector('[aria-hidden="true"]')).toHaveClass(
      'bg-gradient-to-l',
      'md:hidden'
    );
  });

  it('scrolls the newly active tab into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<ControlledTabs />);

    fireEvent.click(screen.getByRole('tab', { name: /Forecast/ }));

    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  });
});
