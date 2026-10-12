import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { PIN_DATA_KEY, PIN_TEXT_KEY } from "../src/state";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import { runMarketReport } from "../src/scheduler/report-job";
import {
  formatMarketReport,
  formatPinnedUsdSingleRate,
  formatUsdMessage,
  formatUsdMessageClosed,
} from "../src/telegram/format";
import type {
  MarketReport,
  ReportItem,
  ReportSymbol,
  UsdTehranPrice,
} from "../src/types";
import {
  alwaysOpenMarketHours,
  fakeProvider,
  makeEnv,
  MockKV,
  telegramRecorder,
} from "./helpers";

/**
 * قواعد «خروجی عمومی کانال» — دستور مالک پروژه (۲۰۲۶-۱۰-۱۱):
 *  ۱) هیچ رقم فارسی/عربی (و جداکنندههای فارسی ٬ ٫) در پیام عمومی نیست؛
 *     قیمت/تاریخ/ساعت/درصد همگی با ارقام انگلیسی 0-9.
 *  ۲) هیچ متن فنی/داخلی («تأییدنشده»، «مرجع»، «خطا»، وضعیتها) به کانال
 *     نمیرود — پیام کوتاه، خوانا، فقط قیمت.
 *  ۳) قطع/خرابی منبع (یا دادهٔ قدیمی که provider آن را null میکند) →
 *     پیام عمومی قبلی «حفظ» میشود؛ هیچ پیام خطا جایگزین نمیشود.
 *  ۴) تتر بدون مرجع مستقل معتبر (Wallex) منتشر نمیشود؛ مقدار قبلی هم
 *     «نرخ تازه» فرض نمیشود.
 *  ۵) پس از بازیابی منبع، پیام «جدید» ارسال می‌شود؛ پیام‌های قبلی هرگز
 *     ویرایش یا حذف نمی‌شوند (مدل پیام جدید — راند ۲۸).
 */

/** ساخت آیتمهای گزارش با نماد تایپ‌شده (جلوگیری از widening به string) */
function reportItems(
  pairs: Array<[ReportSymbol, number | null]>,
): ReportItem[] {
  return pairs.map(([symbol, value]) => ({ symbol, value }));
}

/** ارقام فارسی ۰-۹، عربی ۰-۹ و جداکنندههای فارسی/عربی */
const FA_AR_DIGIT = /[\u06F0-\u06F9\u0660-\u0669\u066B\u066C]/;

/** واژههای فنی/داخلی که هرگز نباید در خروجی عمومی باشند */
const FORBIDDEN_PUBLIC = [
  "تأییدنشده",
  "مرجع",
  "خطا",
  "CROSS_CHECK",
  "UNVERIFIED",
  "reference",
  "provider",
  "no-data",
  "status",
  "advisory",
];

function expectPublicText(text: string | null | undefined, label: string): void {
  expect(text, label).toBeTruthy();
  const value = text ?? "";
  const digitMatch = value.match(FA_AR_DIGIT);
  expect(digitMatch, `${label}: رقم/جداکنندهٔ فارسی یا عربی یافت شد`).toBeNull();
  for (const word of FORBIDDEN_PUBLIC) {
    expect(
      value.includes(word),
      `${label}: واژهٔ فنی «${word}» در خروجی عمومی`,
    ).toBe(false);
  }
}

const DESK: UsdTehranPrice = {
  buy: 253_000,
  sell: 254_200,
  trade: 253_800,
  tether: 253_950,
  updatedAt: "2026-10-11T07:00:00.000Z",
  source: "fake-test",
};

const REPORT: MarketReport = {
  items: [
    { symbol: "usd", value: 253_000 },
    { symbol: "usdt", value: 253_950 },
    { symbol: "eur", value: null },
    { symbol: "gold18k", value: 41_500_000 },
    { symbol: "ounce", value: 2650.45 },
    { symbol: "emami", value: 92_000_000 },
  ],
  fetchedAt: "2025-10-08T10:00:00Z",
  source: "test",
  dataDate: "2025-10-08T01:30:00Z",
};

/** مرجعهای cross-check معتبر و منطبق بر دادهٔ تست؛ تلگرام → recorder */
function withRefs(recorderFetch: typeof fetch, wallexOk = true): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    // منابع تتر جدید (مأموریت ۲۹) در این سناریو «قطع» — همان معنای قبلی
    // تست: تنها مرجع سالم Wallex است (در مسیر recorder حساب نمیشوند).
    if (u.includes("ramzinex") || u.includes("nobitex")) {
      return new Response("upstream unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    if (u.includes("tgju")) {
      const today = new Date(Date.now() - 210 * 60_000)
        .toISOString()
        .slice(0, 10);
      return new Response(
        JSON.stringify({
          current: {
            price_dollar_rl: { p: "2,531,000", ts: `${today} 00:00:00` },
            geram18: { p: "415,000,000", ts: `${today} 00:00:00` },
            sekee: { p: "920,000,000", ts: `${today} 00:00:00` },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("wallex")) {
      if (!wallexOk) {
        return new Response("upstream unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(
        JSON.stringify({
          result: {
            ask: [{ price: 254_000, quantity: 1 }],
            bid: [{ price: 253_900, quantity: 1 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return recorderFetch(url, init);
  }) as typeof fetch;
}

// ---------- ۱) ارقام انگلیسی در همهٔ قالبهای عمومی ----------

describe("خروجی عمومی — فقط ارقام انگلیسی", () => {
  it("پیام ثابت تک‌نرخی (با تتر / بدون تتر / بازار بسته) بدون هیچ رقم فارسی", () => {
    expectPublicText(
      formatPinnedUsdSingleRate(266_200, 266_350, false),
      "single-rate",
    );
    expectPublicText(
      formatPinnedUsdSingleRate(266_200, null, false),
      "single-rate-no-tether",
    );
    expectPublicText(
      formatPinnedUsdSingleRate(266_200, null, true),
      "single-rate-closed",
    );
  });

  it("پیام ثابت میز خرید/فروش (قالب آینده) + حالت بسته — بدون رقم فارسی", () => {
    expectPublicText(formatUsdMessage(DESK), "desk");
    expectPublicText(formatUsdMessageClosed(DESK), "desk-closed");
  });

  it("گزارش ۶ ساعته: قیمت/تاریخ/ساعت با ارقام انگلیسی و جداکنندهٔ «,»/«.»", () => {
    const text = formatMarketReport(REPORT);
    expectPublicText(text, "report");
    expect(text).toContain("دلار: 253,000");
    expect(text).toContain("تتر: 253,950");
    expect(text).toContain("طلای 18 عیار: 41,500,000");
    expect(text).toContain("اونس جهانی: 2,650.45");
    expect(text).toContain("سکه امامی: 92,000,000");
    // تاریخ/ساعت (شمسی، تهران) با ارقام انگلیسی
    expect(text).toContain("1404/07/16 - 13:30");
    expect(text).toContain("دادهٔ منبع: 1404/07/16 - 05:00");
    expect(text).not.toContain("یورو:"); // نبود داده = حذف خط
  });
});

// ---------- ۲) رفتار جاب در قطع/قدیمی بودن منبع و بازیابی ----------

describe("خروجی عمومی در خطای منبع — پیام قبلی حفظ، بدون متن فنی", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("قطع منبع (یا دادهٔ قدیمی → provider null): هیچ تماس تلگرام، پیام قبلی دست‌نخورده", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });

    // انتشار اول: پیام ثابت ساخته و متن آن کش میشود
    await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, {
        ...REPORT,
        items: reportItems([
          ["usd", 253_000],
          ["usdt", 253_950],
        ]),
      }),
      marketHours: alwaysOpenMarketHours(),
    });
    const publishedText = kv.store.get(PIN_TEXT_KEY);
    expectPublicText(publishedText, "first-publish");
    const telegramCallsBefore = calls.length;

    // قطع منبع (provider null — همان رفتار دادهٔ قدیمی/نامعتبر) → عدم انتشار
    const result = await runUsdRefresh(env, {
      fetchFn: fetchFn,
      provider: fakeProvider(null, null),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("no-data");
    // هیچ پیام خطا به کانال نرفت (هیچ تماس تلگرامی جدید)
    expect(calls.length).toBe(telegramCallsBefore);
    // پیام عمومی قبلی «جایگزین نشد» — متن کش دقیقاً همان است
    expect(kv.store.get(PIN_TEXT_KEY)).toBe(publishedText);
    // وضعیت داخلی (بدون متن عمومی) در KV ثبت شد
    expect(kv.store.has("status:usd")).toBe(true);
  });

  it("پس از بازیابی: پیام جدید (پیام قبلی دست‌نخورده) + اجرای بعدی با قیمت یکسان نیز پیام جدید", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const good = {
      ...REPORT,
      items: reportItems([
        ["usd", 253_000],
        ["usdt", 253_950],
      ]),
    };

    // ۱) انتشار اول — یک sendMessage
    await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, good),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(
      calls.filter((c) => c.url.endsWith("/sendMessage")),
    ).toHaveLength(1);

    // ۲) قطع موقت — بدون تماس
    await runUsdRefresh(env, {
      fetchFn: fetchFn,
      provider: fakeProvider(null, null),
      marketHours: alwaysOpenMarketHours(),
    });

    // ۳) بازیابی با نرخ جدید — پیام جدید (نه ویرایش پیام قبلی)
    const recovered = {
      ...good,
      items: reportItems([
        ["usd", 255_000],
        ["usdt", 255_900],
      ]),
    };
    const result = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, recovered),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(sends).toHaveLength(2); // پیام جدید — نه جایگزینی
    expect(edits).toHaveLength(0); // پیام قبلی هرگز ویرایش نشد
    const newText = String(sends[1]?.body.text);
    expectPublicText(newText, "recovery-new-message");
    expect(newText).toContain("<b>255,000</b> معامله");
    expect(newText).toContain("<b>255,900 تومان</b>");
    // متن پیام اول (قبلی) دست‌نخورده مانده — نرخ قبلی
    expect(String(sends[0]?.body.text)).toContain("<b>253,000</b> معامله");
    // pin data هم با نرخ تازهٔ «معتبر» بروز شد
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.value).toBe(255_000);
    expect(pinData.tether).toBe(255_900);

    // ۴) اجرای بعدی با همان داده → باز هم پیام جدید (قیمت یکسان)
    const before = calls.length;
    const again = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, recovered),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(again.status).toBe("ok");
    expect(calls.length).toBe(before + 1); // پیام جدید سوم
    expect(
      calls.filter((c) => c.url.endsWith("/sendMessage")),
    ).toHaveLength(3);
    expect(
      calls.filter((c) => c.url.endsWith("/editMessageText")),
    ).toHaveLength(0);
  });

  it("تتر بدون مرجع Wallex معتبر → خط تتر در پیام عمومی نیست؛ دلار سالم منتشر", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const result = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn, false), // Wallex قطع؛ TGJU سالم
      provider: fakeProvider(null, {
        ...REPORT,
        items: reportItems([
          ["usd", 253_000],
          ["usdt", 253_950],
        ]),
      }),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("TETHER_OMITTED_NO_REFERENCE"); // فقط داخلی (KV/لاگ)
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.body.text);
    expectPublicText(text, "tether-no-ref");
    expect(text).toContain("<b>253,000</b> معامله");
    expect(text).not.toContain("قیمت تتر"); // تتر بدون مرجع: حذف خط
    // مقدار قبلی تتر هم «نرخ تازه» نمایش داده نشد — کش بدون tether
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.tether).toBeUndefined();
  });
});

// ---------- ۳) گزارش ۶ ساعته — بدون متن فنی، تتر بدون مرجع حذف ----------

describe("گزارش عمومی — قطع مرجع و حذف تتر بدون متن فنی", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("Wallex قطع → گزارش بدون خط تتر ارسال میشود؛ هیچ متن خطا در گزارش نیست", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const result = await runMarketReport(env, {
      fetchFn: withRefs(fetchFn, false),
      now: () => new Date("2025-10-08T10:00:00Z"),
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, REPORT),
    });
    expect(result.status).toBe("ok");
    expect(String(result.reason)).toContain("CROSS_CHECK_OMITTED:usdt");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.body.text);
    expectPublicText(text, "report-no-tether");
    expect(text).toContain("دلار: 253,000");
    expect(text).not.toContain("تتر:"); // تتر بدون مرجع مستقل: حذف خط
    expect(text).toContain("سکه امامی: 92,000,000");
  });
});
