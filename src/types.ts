/**
 * تایپ‌های دامنه پروژه — iran-market-price-bot
 *
 * اصل مهم: هیچ مقدار پیش‌فرض/ساختگی برای قیمت‌ها تعریف نمی‌شود.
 * «نبود داده» همیشه با null نمایش داده می‌شود.
 */

/** قیمت دلار فردایی تهران (تومان) */
export interface UsdTehranPrice {
  /** نرخ خرید (میزی خرید) */
  buy: number;
  /** نرخ فروش (میزی فروش) */
  sell: number;
  /** نرخ آخرین معامله */
  trade: number;
  /** زمان آخرین بروزرسانی داده (ISO 8601) */
  updatedAt: string;
  /** شناسه منبع داده (برای لاگ و پیام وضعیت) */
  source: string;
}

/** گروه‌های گزارش بازار */
export type ReportGroup = "currency" | "gold" | "coin";

/** کلیدهای پشتیبانی‌شده در گزارش ۶ ساعته */
export type ReportSymbol =
  | "usd"
  | "eur"
  | "gbp"
  | "try"
  | "aed"
  | "gold18k"
  | "gold24k"
  | "mesghal"
  | "goldMelted"
  | "ounce"
  | "emami"
  | "bahar"
  | "halfCoin"
  | "quarterCoin"
  | "germi";

/**
 * یک آیتم گزارش:
 *  value = عدد  → مقدار واقعی دریافتی از provider
 *  value = null → «در دسترس نبود» (فرمتر این خط را حذف می‌کند — نه جایگزین)
 */
export interface ReportItem {
  symbol: ReportSymbol;
  value: number | null;
  /** واحد نمایش مقدار */
  unit?: "toman" | "rial" | "usd";
  /** زمان آخرین بروزرسانی این آیتم (ISO 8601) در صورت وجود */
  updatedAt?: string;
}

/** گزارش کامل بازار از provider */
export interface MarketReport {
  items: ReportItem[];
  /** زمان دریافت گزارش (ISO 8601) */
  fetchedAt: string;
  /** شناسه منبع داده */
  source: string;
  /**
   * تاریخ «خودِ داده» در منبع (ISO 8601) — اختیاری.
   * نمایش صادقانه: اگر منبع تاریخ جدا برای داده دارد (مثلا فقط date بدون time)
   * در گزارش لحظه رندر میشود تا قدم داده روشن باشد.
   */
  dataDate?: string;
}
