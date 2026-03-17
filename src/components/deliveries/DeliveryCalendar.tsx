import { useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventInput, EventClickArg } from '@fullcalendar/core';
import type { DateClickArg } from '@fullcalendar/interaction';

interface DeliveryEvent {
  id: string;
  delivery_number: string;
  customer_name: string;
  driver_name: string;
  scheduled_date: string;
  status: string;
  priority?: string;
  item_count: number;
}

interface DeliveryCalendarProps {
  deliveries: DeliveryEvent[];
  onDeliveryClick: (deliveryId: string) => void;
  onDateClick: (date: string) => void;
}

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  scheduled: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
  in_progress: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
  completed: { bg: '#d1fae5', border: '#10b981', text: '#065f46' },
  cancelled: { bg: '#f3f4f6', border: '#9ca3af', text: '#6b7280' },
  voided: { bg: '#f3f4f6', border: '#9ca3af', text: '#6b7280' },
};

export default function DeliveryCalendar({ deliveries, onDeliveryClick, onDateClick }: DeliveryCalendarProps) {
  const events: EventInput[] = useMemo(() =>
    deliveries.map((d) => {
      const colors = STATUS_COLORS[d.status] || STATUS_COLORS.scheduled;
      return {
        id: d.id,
        title: `${d.delivery_number} — ${d.customer_name}`,
        date: d.scheduled_date,
        backgroundColor: colors.bg,
        borderColor: colors.border,
        textColor: colors.text,
        extendedProps: {
          status: d.status,
          driver: d.driver_name,
          items: d.item_count,
          priority: d.priority,
        },
      };
    }),
    [deliveries]
  );

  const handleEventClick = (info: EventClickArg) => {
    onDeliveryClick(info.event.id);
  };

  const handleDateClick = (info: DateClickArg) => {
    onDateClick(info.dateStr);
  };

  return (
    <div className="delivery-calendar">
      <style>{`
        .delivery-calendar .fc {
          --fc-border-color: #e5e7eb;
          --fc-today-bg-color: #f0fdf4;
          font-family: inherit;
        }
        .delivery-calendar .fc-toolbar-title {
          font-size: 1.125rem !important;
          font-weight: 600;
          color: #1e293b;
        }
        .delivery-calendar .fc-button-primary {
          background-color: #28A26A !important;
          border-color: #28A26A !important;
          font-size: 0.8125rem !important;
          padding: 0.375rem 0.75rem !important;
          border-radius: 0.5rem !important;
        }
        .delivery-calendar .fc-button-primary:hover {
          background-color: #1f8a59 !important;
          border-color: #1f8a59 !important;
        }
        .delivery-calendar .fc-button-primary:disabled {
          background-color: #9ca3af !important;
          border-color: #9ca3af !important;
        }
        .delivery-calendar .fc-button-primary.fc-button-active {
          background-color: #166534 !important;
          border-color: #166534 !important;
        }
        .delivery-calendar .fc-event {
          cursor: pointer;
          font-size: 0.75rem;
          padding: 2px 4px;
          border-radius: 4px;
          border-left-width: 3px;
        }
        .delivery-calendar .fc-daygrid-day-number {
          font-size: 0.8125rem;
          color: #64748b;
          padding: 4px 8px;
        }
        .delivery-calendar .fc-col-header-cell-cushion {
          font-size: 0.75rem;
          font-weight: 600;
          color: #475569;
          text-transform: uppercase;
        }
        .delivery-calendar .fc-daygrid-day:hover {
          background-color: #f8fafc;
        }
        .delivery-calendar .fc-daygrid-more-link {
          color: #28A26A;
          font-weight: 600;
          font-size: 0.75rem;
        }
      `}</style>
      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,dayGridWeek',
        }}
        events={events}
        eventClick={handleEventClick}
        dateClick={handleDateClick}
        dayMaxEvents={4}
        height="auto"
        eventDisplay="block"
      />
      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-3 px-1">
        {[
          { label: 'Scheduled', color: '#3b82f6' },
          { label: 'In Progress', color: '#f59e0b' },
          { label: 'Completed', color: '#10b981' },
          { label: 'Cancelled', color: '#9ca3af' },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 text-xs text-secondary">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: item.color }} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}
