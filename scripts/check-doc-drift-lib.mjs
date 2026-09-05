export function parseLatestMigrationHistoryEntry(history) {
  return history.match(
    /^#\s*Migration History\s*\(latest entry\s+(\d+)\)/mi,
  )?.[1];
}

export function chicagoCalendarStamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}${value('month')}${value('day')}`;
}

export function manualFreshnessBoundary(newestMigrationDate, todayChicago) {
  if (!newestMigrationDate) return undefined;
  return newestMigrationDate > todayChicago ? todayChicago : newestMigrationDate;
}
