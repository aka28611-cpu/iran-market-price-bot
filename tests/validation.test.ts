import { describe, expect, it } from "vitest";
import type { ReportItem } from "../src/types";
import {
  MAX_PRICE_AGE_MS,
  sanitizeReportItems,
  validateUsdPrice,
} from "../src/validation";
import { fakeUsdPrice } from "./helpers";

describe("validateUsdPrice — fail-closed", () => {
  const NOW = Date.parse("2025-10-08T10:00:00Z");
  const FRESH = "2025-10-08T09:55:00Z";

  it("داده تازه و منطقی را می‌پذیرد", () => {
    expect(validateUsdPrice(fakeUsdPrice({ updatedAt: FRESH }), NOW)).toEqual({
      ok: true,
    });
  });

  it("خرید > فروش را رد می‌کند (داده خراب)", () => {
    const price = fakeUsdPrice({
      buy: 260_000,
      sell: 254_000,
      updatedAt: FRESH,
    });
    expect(validateUsdPrice(price, NOW).reason).toBe("BUY_GT_SELL");
  });

  it("قیمت صفر/NaN/بیش از حد بزرگ را رد می‌کند", () => {
    expect(
      validateUsdPrice(fakeUsdPrice({ buy: 0, updatedAt: FRESH }), NOW).reason,
    ).toBe("INVALID_BUY");
    expect(
      validateUsdPrice(fakeUsdPrice({ sell: Number.NaN, updatedAt: FRESH }), NOW)
        .reason,
    ).toBe("INVALID_SELL");
    expect(
      validateUsdPrice(
        fakeUsdPrice({ trade: Number.POSITIVE_INFINITY, updatedAt: FRESH }),
        NOW,
      ).reason,
    ).toBe("INVALID_TRADE");
  });

  it("داده کهنه را رد می‌کند", () => {
    const stale = new Date(NOW - MAX_PRICE_AGE_MS - 5_000).toISOString();
    expect(
      validateUsdPrice(fakeUsdPrice({ updatedAt: stale }), NOW).reason,
    ).toBe("STALE_DATA");
  });

  it("داده آینده (فراتر از تلورانس) را رد می‌کند", () => {
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    expect(
      validateUsdPrice(fakeUsdPrice({ updatedAt: future }), NOW).reason,
    ).toBe("FUTURE_DATA");
  });

  it("timestamp نامعتبر را رد می‌کند", () => {
    expect(
      validateUsdPrice(fakeUsdPrice({ updatedAt: "not-a-date" }), NOW).reason,
    ).toBe("INVALID_TIMESTAMP");
  });

  it("source خالی را رد می‌کند", () => {
    expect(
      validateUsdPrice(fakeUsdPrice({ source: "", updatedAt: FRESH }), NOW)
        .reason,
    ).toBe("INVALID_SOURCE");
  });
});

describe("sanitizeReportItems — حذف نامعتبر، نه جایگزین", () => {
  it("آیتم معتبر و null را نگه می‌دارد؛ مقدار خراب را حذف می‌کند", () => {
    const items = [
      { symbol: "usd", value: 253_000 },
      { symbol: "eur", value: null },
      { symbol: "emami", value: -5 },
      { symbol: "gold18k", value: Number.NaN },
    ] as ReportItem[];
    const kept = sanitizeReportItems(items);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.symbol).toBe("usd");
    expect(kept[1]?.symbol).toBe("eur");
  });
});
