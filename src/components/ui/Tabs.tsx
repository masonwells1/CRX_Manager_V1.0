import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  key: string;
  label: ReactNode;
  content: ReactNode;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
  className?: string;
}

export default function Tabs({
  tabs,
  activeKey,
  onChange,
  ariaLabel = 'Tabs',
  className = '',
}: TabsProps) {
  const id = useId().replace(/:/g, '');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;

    onChange(tab.key);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    selectTab(nextIndex);
  };

  return (
    <div className={`font-sub ${className}`}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto border-b border-gray-200"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.key === activeKey;
          const tabId = `${id}-tab-${index}`;
          const panelId = `${id}-panel-${index}`;

          return (
            <button
              key={tab.key}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`
                -mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-2
                text-sm font-medium whitespace-nowrap transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30
                focus-visible:ring-offset-2
                ${isActive
                  ? 'border-crx-green text-crx-green'
                  : 'border-transparent text-secondary hover:text-nav-dark'}
              `}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium leading-none ${
                    isActive
                      ? 'bg-crx-green-light text-crx-green'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;

        return (
          <div
            key={tab.key}
            id={`${id}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${index}`}
            tabIndex={0}
            hidden={!isActive}
          >
            {isActive ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
