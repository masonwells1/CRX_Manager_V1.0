/**
 * NewDelivery.driver-guardrail.test.tsx — Regression test for audit finding #1
 * (2026-04-10 functional audit). Pins the deps-array contract for the
 * checkDriverLoad effect so it re-fires once the drivers list resolves async.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect } from 'react';

interface CheckArgs {
  driverId: string;
  scheduledDate: string;
  driverName?: string;
}

// Mirror of the effect block in src/pages/NewDelivery.tsx (lines 214-220).
// Keep deps array IDENTICAL to the page's.
function DriverGuardrailHarness({
  selectedDriverId,
  scheduledDate,
  drivers,
  checkDriverLoad,
}: {
  selectedDriverId: string;
  scheduledDate: string;
  drivers: Array<{ id: string; full_name: string }>;
  checkDriverLoad: (args: CheckArgs) => void;
}) {
  useEffect(() => {
    if (selectedDriverId && scheduledDate) {
      const driver = drivers.find((d) => d.id === selectedDriverId);
      checkDriverLoad({
        driverId: selectedDriverId,
        scheduledDate,
        driverName: driver?.full_name,
      });
    }
  }, [selectedDriverId, scheduledDate, drivers, checkDriverLoad]);
  return null;
}

describe('NewDelivery driver guardrail dependency contract', () => {
  it('re-fires checkDriverLoad with driverName once drivers list resolves async', () => {
    const checkDriverLoad = vi.fn();

    const { rerender } = render(
      <DriverGuardrailHarness
        selectedDriverId="driver-1"
        scheduledDate="2026-04-28"
        drivers={[]}
        checkDriverLoad={checkDriverLoad}
      />,
    );

    expect(checkDriverLoad).toHaveBeenCalledTimes(1);
    expect(checkDriverLoad).toHaveBeenLastCalledWith({
      driverId: 'driver-1',
      scheduledDate: '2026-04-28',
      driverName: undefined,
    });

    rerender(
      <DriverGuardrailHarness
        selectedDriverId="driver-1"
        scheduledDate="2026-04-28"
        drivers={[{ id: 'driver-1', full_name: 'Bob Smith' }]}
        checkDriverLoad={checkDriverLoad}
      />,
    );

    expect(checkDriverLoad).toHaveBeenCalledTimes(2);
    expect(checkDriverLoad).toHaveBeenLastCalledWith({
      driverId: 'driver-1',
      scheduledDate: '2026-04-28',
      driverName: 'Bob Smith',
    });
  });

  it('does not call checkDriverLoad when driver or date is missing', () => {
    const checkDriverLoad = vi.fn();
    render(
      <DriverGuardrailHarness
        selectedDriverId=""
        scheduledDate=""
        drivers={[]}
        checkDriverLoad={checkDriverLoad}
      />,
    );
    expect(checkDriverLoad).not.toHaveBeenCalled();
  });

  it('does not call checkDriverLoad when only driver is set without date', () => {
    const checkDriverLoad = vi.fn();
    render(
      <DriverGuardrailHarness
        selectedDriverId="driver-1"
        scheduledDate=""
        drivers={[{ id: 'driver-1', full_name: 'Bob Smith' }]}
        checkDriverLoad={checkDriverLoad}
      />,
    );
    expect(checkDriverLoad).not.toHaveBeenCalled();
  });
});
