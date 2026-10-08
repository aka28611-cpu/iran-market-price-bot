import type { ReportItem, UsdTehranPrice } from "./types";

/**
 * اعتبارسنجی قیمت — fail-closed.
 *
 * اصل: هیچ مقدار اصلاحی/جایگزین (fallback) تولید نمی‌شود.
 * داده نامعتبر = عدم انتشار (نه نمایش، نه تخمین).
 */

/** حداکثر عمر مجاز داده قیمت (۱۰ دقیقه) */
export const MAX_PRICE_AGE_MS = 10 * 60 * 1000;
/** تلورانس داده «آینده» (اسکیو ساعت منبع) */
export const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
/** سقف منطقی مقدار (ریال/تومان) برای رد داده خراب */
export const MAX_REASONABLE_PRICE = 1e15;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

function isPositiveFinite(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n > 0 &&
    n <= MAX_REASONABLE_PRICE
  );
}

export function validateUsdPrice(
  price: UsdTehranPrice,
  nowMs = Date.now(),
): ValidationResult {
  if (!isPositiveFinite(price.buy)) return { ok: false, reason: "INVALID_BUY" };
  if (!isPositiveFinite(price.sell))
    return { ok: false, reason: "INVALID_SELL" };
  if (!isPositiveFinite(price.trade))
    return { ok: false, reason: "INVALID_TRADE" };
  // در بازار فردایی تهران خرید همیشه ≤ فروش است؛ تخطی یعنی داده خراب
  if (price.buy > price.sell) return { ok: false, reason: "BUY_GT_SELL" };

  const ts = Date.parse(price.updatedAt);
  if (Number.isNaN(ts)) return { ok: false, reason: "INVALID_TIMESTAMP" };
  const age = nowMs - ts;
  if (age > MAX_PRICE_AGE_MS) return { ok: false, reason: "STALE_DATA" };
  if (age < -FUTURE_TOLERANCE_MS) return { ok: false, reason: "FUTURE_DATA" };

  if (!price.source || price.source.length > 100)
    return { ok: false, reason: "INVALID_SOURCE" };

  return { ok: true };
}

/**
 * آیتمهای معتبر گزارش را نگه می‌دارد؛ مقادیر نامعتبر حذف می‌شوند (نه جایگزین).
 * value == null یعنی «در دسترس نبود» و مجاز است (فرمتر آن خط را نمایش نمی‌دهد).
 */
export function sanitizeReportItems(items: ReportItem[]): ReportItem[] {
  return items.filter((item) => {
    if (item.value == null) return true;
    return isPositiveFinite(item.value);
  });
}
