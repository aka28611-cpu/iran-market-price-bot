import type { MarketReport, UsdTehranPrice } from "../types";

/**
 * قرارداد provider قیمت.
 *
 * قواعد الزامی برای هر پیاده‌سازی:
 *  • «نبود داده» = null — هرگز مقدار ساختگی/تخمینی/کش‌شده برنگردانید.
 *  • خطای شبکه/پاسخ = throw یا null؛ تصمیم انتشار با جاب است (fail-closed).
 *  • هیچ endpoint یا کلید hard-code نمی‌شود؛ همه از env می‌آید.
 */
export interface PriceProvider {
  readonly name: string;
  /** قیمت دلار فردایی تهران: خرید/فروش/معامله + زمان آخرین بروزرسانی */
  fetchUsdTehran(): Promise<UsdTehranPrice | null>;
  /** گزارش کامل بازار (ارز/طلا/سکه) — فقط آیتمهای موجود در منبع */
  fetchMarketReport(): Promise<MarketReport | null>;
}

export class UnknownProviderError extends Error {
  constructor(public readonly providerName: string) {
    super(`Unknown price provider: ${providerName}`);
    this.name = "UnknownProviderError";
  }
}
