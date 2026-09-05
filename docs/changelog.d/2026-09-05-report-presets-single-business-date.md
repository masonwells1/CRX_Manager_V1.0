## 2026-09-05 - Report presets use one Chicago date snapshot

The Reports page now samples Crop RX's Chicago business date once per date-preset
calculation. This prevents a browser resuming exactly across Chicago midnight from
combining the next day's rolling-range start with the previous day's end date and
silently omitting one day from a 30-day or 90-day report.

A focused regression makes the date source return two different business days and
proves the preset consumes only the first snapshot.
