// Small shared helpers.

// Normalise a query/prefix into a canonical form so that "iPhone", "  IPHONE  ",
// and "iphone" all collide on the same key. This gives case-insensitive matching
// and de-duplication for free.
export function normalize(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Every prefix of a string, up to `maxLen` characters. Used to invalidate cache
// entries: when "iphone" changes, the cached results for "i", "ip", ... "iphone"
// may all be stale.
export function prefixesOf(str: string, maxLen = Infinity): string[] {
  const limit = Math.min(str.length, maxLen);
  const out: string[] = [];
  for (let i = 1; i <= limit; i++) out.push(str.slice(0, i));
  return out;
}

// Quantile from an array of numbers (q in [0,1]). Operates on a copy.
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Stable string comparison for deterministic tie-breaks.
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
