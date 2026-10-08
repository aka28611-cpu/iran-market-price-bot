import { describe, expect, it } from "vitest";
import type { MarketReport } from "../src/types";
import { formatMarketReport, formatUsdMessage } from "../src/telegram/format";

const PRICE = {
  buy: 253_000,
  sell: 254_200,
  trade: 253_800,
  updatedAt: "2025-10-08T10:00:00Z",
  source: "test",
};

describe("formatUsdMessage — پیام ۱ دقیقه‌ای", () => {
  it("هر چهار فیلد الزامی را به فارسی دارد", () => {
    const text = formatUsdMessage(PRICE);
    expect(text).toContain("دلار فردایی تهران");
    expect(text).toContain("خرید: ۲۵۳٬۰۰۰");
    expect(text).toContain("فروش: ۲۵۴٬۲۰۰");
    expect(text).toContain("معامله: ۲۵۳٬۸۰۰");
    expect(text).toContain("بروزرسانی: ۱۴۰۴/۰۷/۱۶ - ۱۳:۳۰");
  });
});

describe("formatMarketReport — گزارش ۶ ساعته", () => {
  it("آیتمهای موجود را می‌آورد و نبود را حذف می‌کند (بدون مقدارسازی)", () => {
    const report: MarketReport = {
      fetchedAt: "2025-10-08T10:00:00Z",
      source: "test",
      items: [
        { symbol: "usd", value: 253_000 },
        { symbol: "eur", value: null },
        { symbol: "gold18k", value: 41_500_000 },
        { symbol: "ounce", value: 2650.45 },
        { symbol: "emami", value: 92_000_000 },
      ],
    };
    const text = formatMarketReport(report);
    expect(text).toContain("دلار: ۲۵۳٬۰۰۰");
    expect(text).toContain("طلای ۱۸ عیار: ۴۱٬۵۰۰٬۰۰۰");
    expect(text).toContain("اونس جهانی: ۲٬۶۵۰٫۴۵");
    expect(text).toContain("سکه امامی: ۹۲٬۰۰۰٬۰۰۰");
    expect(text).not.toContain("یورو:"); // نبود داده = حذف خط
  });

  it("بدون هیچ آیتم معتبر → null (عدم انتشار)", () => {
    const report: MarketReport = {
      fetchedAt: "2025-10-08T10:00:00Z",
      source: "test",
      items: [{ symbol: "eur", value: null }],
    };
    expect(formatMarketReport(report)).toBeNull();
  });
});
