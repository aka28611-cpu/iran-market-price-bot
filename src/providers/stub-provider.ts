import { logInfo } from "../logging";
import type { MarketReport, UsdTehranPrice } from "../types";
import type { PriceProvider } from "./provider";

/**
 * Stub شفاف — تا زمانی که provider واقعی مشخص و پیاده شود.
 *
 * ⚠️ عمداً هیچ داده‌ای برنمی‌گرداند (null) تا:
 *   1) هیچ مقدار ساختگی/تخمینی در کانال منتشر نشود
 *   2) مسیر fail-closed (عدم انتشار) از همین الان قابل تست باشد
 *
 * افزودن provider واقعی: پیاده‌سازی PriceProvider در همین پوشه +
 * ثبت نام آن در registry.ts (بدون hard-code کردن endpoint در کد).
 */
export class StubProvider implements PriceProvider {
  readonly name = "stub";

  async fetchUsdTehran(): Promise<UsdTehranPrice | null> {
    logInfo("provider.stub.no-data", { provider: this.name, job: "usd" });
    return null;
  }

  async fetchMarketReport(): Promise<MarketReport | null> {
    logInfo("provider.stub.no-data", { provider: this.name, job: "report" });
    return null;
  }
}
