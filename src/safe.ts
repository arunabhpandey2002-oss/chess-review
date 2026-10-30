// Small helpers that keep outside data from turning into code or links.
/** Returns the URL only if it is a plain http(s) link; anything else (javascript:, data:, ...) becomes ''. */
export function safeUrl(u: unknown): string {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}
