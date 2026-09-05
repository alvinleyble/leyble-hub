// Date & time formatter for mobile order cards
// Formats timestamps as `MMM d, h:mma` (e.g. `Jul 3, 12:28 PM`), with safe fallback for invalid or missing dates.

export function formatCardDateTime(value) {
  if (!value) return '';
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-PH', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}
