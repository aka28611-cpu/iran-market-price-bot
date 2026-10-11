import { describe, expect, it } from "vitest";
import type { MarketReport, UsdTehranPrice } from "../src/types";
import {
  formatEnMoney,
  formatMarketReport,
  formatPinnedUsdSingleRate,
  formatUsdMessage,
  formatUsdMessageClosed,
} from "../src/telegram/format";

const PRICE: UsdTehranPrice = {
  buy: 253_000,
  sell: 254_200,
  trade: 253_800,
  tether: 253_950,
  updatedAt: "2025-10-08T10:00:00Z",
  source: "test",
};

// ---------- اعداد انگلیسی (قالب عمومی کانال) ----------

describe("formatEnMoney — ارقام انگلیسی با جداکننده هزارگان «,»", () => {
  it("265100 → «265,100»", () => {
    expect(formatEnMoney(265_100)).toBe("265,100");
  });
  it("عدد سهرقمی بدون جداکننده: 999 → «999»", () => {
    expect(formatEnMoney(999)).toBe("999");
  });
  it("گروهبندی بزرگ: 1234567 → «1,234,567»", () => {
    expect(formatEnMoney(1_234_567)).toBe("1,234,567");
  });
  it("گرد شدن نمایش: 265100.4 → «265,100»", () => {
    expect(formatEnMoney(265_100.4)).toBe("265,100");
  });
  it("مقدار غیرمجاز (NaN) → «—»", () => {
    expect(formatEnMoney(Number.NaN)).toBe("—");
  });
});

// ---------- قالب پیام ثابت دلار (دلار فردایی + تتر) ----------

describe("formatUsdMessage — مسیر میز (خرید/فروش/معامله واقعی)", () => {
  const text = formatUsdMessage(PRICE);

  it("سه خط میز دقیقاً مطابق قالب مالک پروژه (بولد HTML + ارقام انگلیسی)", () => {
    expect(text).toContain("💸 دلار فردایی تهران 💵 <b>253,000</b> خرید 💸");
    expect(text).toContain("💸 دلار فردایی تهران 💵 <b>254,200</b> فروش 💵");
    expect(text).toContain("💸 دلار فردایی تهران 💵 <b>253,800</b> معامله ✅");
  });

  it("جداکننده + خط تتر مستقل با واحد تومان", () => {
    expect(text).toContain("━━━━━━━━━━━━━━");
    expect(text).toContain("💵 قیمت تتر: <b>253,950 تومان</b>");
  });

  it("ترتیب بلوکها: میز → جداکننده → تتر", () => {
    expect(text.indexOf("معامله ✅")).toBeLessThan(text.indexOf("━━"));
    expect(text.indexOf("━━")).toBeLessThan(text.indexOf("قیمت تتر"));
  });

  it("بدون نام منبع / زمان دریافت / جزئیات فنی", () => {
    expect(text).not.toContain("بروزرسانی");
    expect(text).not.toContain("منبع");
    expect(text).not.toContain(PRICE.source);
  });

  it("نبود تتر → حذف کامل خط تتر و جداکننده (بدون ساخت مقدار)", () => {
    const noTether = formatUsdMessage({ ...PRICE, tether: undefined });
    expect(noTether).not.toContain("قیمت تتر");
    expect(noTether).not.toContain("━━");
  });

  it("ساختار سطرها با خط خالی بین بلوکها (مطابق نمونه)", () => {
    expect(text).toContain("معامله ✅\n\n━━━━━━━━━━━━━━\n💵 قیمت تتر:");
  });
});

describe("formatUsdMessageClosed — نشان بازار بسته", () => {
  it("همان قالب + خط بسته در انتها", () => {
    const text = formatUsdMessageClosed(PRICE);
    expect(text).toContain("🌙 بازار بسته است");
    expect(text).toContain("<b>253,800</b> معامله ✅");
    expect(text).toContain("<b>253,950 تومان</b>");
    expect(text.endsWith("🌙 بازار بسته است")).toBe(true);
  });
});

describe("formatPinnedUsdSingleRate — منبع تکنرخی (نرخ واحد واقعی)", () => {
  it("فقط خط «معامله» + تتر — بدون ساخت خرید/فروش از نرخ واحد", () => {
    const text = formatPinnedUsdSingleRate(266_200, 266_350, false);
    expect(text).toBe(
      "💸 دلار فردایی تهران 💵 <b>266,200</b> معامله ✅\n\n" +
        "━━━━━━━━━━━━━━\n💵 قیمت تتر: <b>266,350 تومان</b>",
    );
    expect(text).not.toContain("خرید");
    expect(text).not.toContain("فروش");
  });

  it("تتر غایب → فقط خط معامله (بدون جداکننده/خط تتر)", () => {
    const text = formatPinnedUsdSingleRate(266_200, null, false);
    expect(text).toBe("💸 دلار فردایی تهران 💵 <b>266,200</b> معامله ✅");
    expect(text).not.toContain("قیمت تتر");
    expect(text).not.toContain("━━");
  });

  it("تتر نامعتبر (صفر/منفی/NaN) → حذف خط تتر", () => {
    expect(formatPinnedUsdSingleRate(1, 0, false)).not.toContain("قیمت تتر");
    expect(formatPinnedUsdSingleRate(1, -5, false)).not.toContain("قیمت تتر");
    expect(formatPinnedUsdSingleRate(1, Number.NaN, false)).not.toContain(
      "قیمت تتر",
    );
  });

  it("حالت بسته → خط بسته در انتها", () => {
    const text = formatPinnedUsdSingleRate(266_200, 266_350, true);
    expect(text).toContain("🌙 بازار بسته است");
    expect(text.endsWith("🌙 بازار بسته است")).toBe(true);
  });

  it("بدون نام منبع / تاریخ داده / جزئیات فنی", () => {
    const text = formatPinnedUsdSingleRate(266_200, 266_350, false);
    expect(text).not.toContain("منبع");
    expect(text).not.toContain("دادهٔ");
    expect(text).not.toContain("۲۶۶"); // ارقام فارسی در قالب عمومی نیست
  });
});

// ---------- گزارش ۶ ساعته (متن خام، ارقام فارسی) ----------

describe("formatMarketReport — گزارش ۶ ساعته", () => {
  it("آیتمهای موجود را میآورد و نبود را حذف میکند (بدون مقدارسازی)", () => {
    const report: MarketReport = {
      fetchedAt: "2025-10-08T10:00:00Z",
      source: "test",
      items: [
        { symbol: "usd", value: 253_000 },
        { symbol: "usdt", value: 253_950 },
        { symbol: "eur", value: null },
        { symbol: "gold18k", value: 41_500_000 },
        { symbol: "ounce", value: 2650.45 },
        { symbol: "emami", value: 92_000_000 },
      ],
    };
    const text = formatMarketReport(report);
    expect(text).toContain("دلار: ۲۵۳٬۰۰۰");
    expect(text).toContain("تتر: ۲۵۳٬۹۵۰");
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
