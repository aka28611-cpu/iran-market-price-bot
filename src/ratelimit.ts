/**
 * Rate limiting درون-حافظه‌ای (fixed window).
 *
 * ⚠️ محدودیت مستند: Cloudflare Workerها روی isolateهای متعدد اجرا می‌شوند؛
 * این پیاده‌سازی «بهترین تلاش» در هر isolate است و لایه دفاعی در کنار
 * سایر لایه‌هاست (authorization، webhook secret) — نه جایگزین آن‌ها.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
const SWEEP_INTERVAL_MS = 1_000;

let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) buckets.clear();
}

/** true = مجاز؛ false = عبور از سقف در بازه جاری */
export function rateLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): boolean {
  if (limit <= 0) return false;
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

/** فقط برای تست — بازنشانی state ماژول */
export function resetRateLimiterForTests(): void {
  buckets.clear();
  lastSweep = 0;
}
