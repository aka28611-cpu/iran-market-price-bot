import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import {
  PIN_DATA_KEY,
  PIN_TEXT_KEY,
  USD_MESSAGE_ID_KEY,
  USD_STATUS_KEY,
} from "../src/state";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import type { MarketReport } from "../src/types";
import {
  alwaysOpenMarketHours,
  makeEnv,
  MockKV,
  telegramRecorder,
  fakeProvider,
} from "./helpers";

/**
 * مسیر «تک‌نرخی» جاب دلار (منابعی مثل jahankhahan که میز خرید/فروش ندارند).
 * اصول fail-closed حفظ می‌شود: بدون داده = بدون انتشار، بدون مقدار جایگزین.
 * قالب عمومی کانال (۱۴۰۵/۰۷): خط «معامله» + تتر مستقل — خرید/فروش از نرخ
 * واحد ساخته نمی‌شوند (مقدار جعلی ممنوع — دستور مالک پروژه).
 */

const USER_REPORT: MarketReport = {
  items: [
    { symbol: "usd", value: 266_200, unit: "toman" },
    { symbol: "usdt", value: 266_350, unit: "toman" },
    { symbol: "eur", value: 299_010, unit: "toman" },
  ],
  fetchedAt: new Date().toISOString(),
  source: "fake-single",
  dataDate: new Date().toISOString(),
};

/**
 * مرجعهای cross-check معتبر و منطبق بر USER_REPORT (دستور مالک ۲۰۲۶-۱۰-۱۱:
 * تتر فقط با مرجع Wallex معتبر منتشر میشود — تستهای «انتشار تتر» باید مرجع
 * سالم داشته باشند). تلگرام → همان recorder (برای assertion تماسها).
 */
function withRefs(recorderFetch: typeof fetch): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    // منابع تتر جدید (مأموریت ۲۹) در این سناریو «قطع» — تنها مرجع سالم Wallex.
    if (u.includes("ramzinex") || u.includes("nobitex")) {
      return new Response("upstream unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    if (u.includes("tgju")) {
      // مهر تازه (نیمه‌شب تهران امروز) — همیشه داخل پنجرهٔ ۷۲h
      const today = new Date(Date.now() - 210 * 60_000).toISOString().slice(0, 10);
      return new Response(
        JSON.stringify({
          current: { price_dollar_rl: { p: "2,651,000", ts: `${today} 00:00:00` } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("wallex")) {
      // میانگین 264,299 — اختلاف ~0.8٪ با تتر USER_REPORT (داخل آستانهٔ ۳٪)
      return new Response(
        JSON.stringify({
          result: {
            ask: [{ price: 264_300, quantity: 1 }],
            bid: [{ price: 264_297, quantity: 1 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return recorderFetch(url, init);
  }) as typeof fetch;
}

describe("runUsdRefresh — مسیر تک‌نرخی", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("provider بدون میز خرید/فروش → نرخ واحد + تتر مستقل در قالب عمومی کانال منتشر می‌شود", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const provider = fakeProvider(null, USER_REPORT);

    const result = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider,
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    // اولین اجرا: sendMessage به کانال (پیام ثابت جدید)
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.chat_id).toBe(env.CHANNEL_ID);
    // قالب مالک پروژه: خط «معامله» + جداکننده + تتر مستقل
    expect(String(sent[0]?.body.text)).toBe(
      "💸 دلار فردایی تهران 💵 <b>266,200</b> معامله ✅\n\n" +
        "━━━━━━━━━━━━━━\n💵 قیمت تتر: <b>266,350 تومان</b>",
    );
    // ارسال با parse_mode=HTML (رندر بولد تلگرام)
    expect(sent[0]?.body.parse_mode).toBe("HTML");
    // بدون ساخت buy/sell از نرخ واحد — خطهای خرید/فروش وجود ندارند
    expect(String(sent[0]?.body.text)).not.toContain("خرید");
    expect(String(sent[0]?.body.text)).not.toContain("فروش");
    // بدون نام منبع / زمان / جزئیات فنی / ارقام فارسی
    expect(String(sent[0]?.body.text)).not.toContain("منبع");
    expect(String(sent[0]?.body.text)).not.toContain("نرخ دلار");
    expect(String(sent[0]?.body.text)).not.toContain("۲");
    // دادهٔ pinned ذخیره شد — شامل تتر مستقل
    expect(kv.store.has(PIN_TEXT_KEY)).toBe(true);
    expect(kv.store.has(PIN_DATA_KEY)).toBe(true);
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.value).toBe(266_200);
    expect(pinData.tether).toBe(266_350);
    expect(pinData.dataDate).toBe(USER_REPORT.dataDate);
    expect(kv.store.has(USD_MESSAGE_ID_KEY)).toBe(true);
  });

  it("گزارش بدون آیتم تتر → پیام فقط با خط معامله (خط تتر حذف — نه جایگزین)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv({ STATE: new MockKV() });
    const report: MarketReport = {
      ...USER_REPORT,
      items: [
        { symbol: "usd", value: 266_200, unit: "toman" },
        { symbol: "eur", value: 299_010, unit: "toman" },
      ],
    };
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, report),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toBe(
      "💸 دلار فردایی تهران 💵 <b>266,200</b> معامله ✅",
    );
    expect(String(sent[0]?.body.text)).not.toContain("قیمت تتر");
    expect(String(sent[0]?.body.text)).not.toContain("━━");
    // تتر هرگز از دلار ساخته نمی‌شود (266_200 نمایش داده شد، نه کپی در خط تتر)
    expect(String(sent[0]?.body.text)).not.toContain("قیمت تتر: <b>266,200");
  });

  it("اجرای دوم با دادهٔ یکسان → پیام جدید دوم (قیمت یکسان هم پیام جدید) — بدون هیچ ویرایش", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const provider = fakeProvider(null, USER_REPORT);

    await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    const result = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider,
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    // دو پیام جدید (هر اجرای معتبر یک پیام) — حتی با قیمت یکسان
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(2);
    // پیام قبلی هرگز ویرایش نشد
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(0);
    // متن هر دو پیام یکسان است — پیام دوم هم واقعاً «ارسال» شد
    expect(String(sends[1]?.body.text)).toBe(String(sends[0]?.body.text));
  });

  it("تغییر نرخ → پیام جدید با نرخ جدید (پیام قبلی دست‌نخورده)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });

    await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    const changed: MarketReport = {
      ...USER_REPORT,
      items: [
        { symbol: "usd", value: 270_000, unit: "toman" },
        { symbol: "usdt", value: 270_150, unit: "toman" },
        { symbol: "eur", value: 299_010, unit: "toman" },
      ],
    };
    const result = await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: fakeProvider(null, changed),
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined();
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    // پیام دوم «جدید» است — ویرایشی در کار نیست
    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
    expect(String(sends[1]?.body.text)).toContain("<b>270,000</b> معامله");
    expect(String(sends[1]?.body.text)).toContain("<b>270,150 تومان</b>");
    expect(sends[1]?.body.parse_mode).toBe("HTML");
    // متن پیام اول (قبلی) دست‌نخورده مانده — نرخ قبلی
    expect(String(sends[0]?.body.text)).toContain("<b>266,200</b> معامله");
    // دادهٔ pinned هم با نرخ جدید نوشته شد
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.tether).toBe(270_150);
  });

  it("گزارش بدون آیتم usd → no-data بدون انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const report: MarketReport = {
      ...USER_REPORT,
      items: [{ symbol: "eur", value: 299_010, unit: "toman" }],
    };
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, report),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("no-data");
    expect(result.reason).toBe("USD_ITEM_UNAVAILABLE");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
  });

  it("گزارش null → no-data (SINGLE_RATE_SOURCE_UNAVAILABLE)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv({ STATE: new MockKV() });
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, null),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("no-data");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
  });

  it("خطای provider در مسیر گزارش → provider-error بدون انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv({ STATE: new MockKV() });
    const provider = {
      name: "boom",
      async fetchUsdTehran() {
        return null;
      },
      async fetchMarketReport() {
        throw new Error("upstream exploded");
      },
    };
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("provider-error");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
  });
});

describe("runUsdRefresh — بازار بسته با دادهٔ تک‌نرخ کش‌شده", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("نمایش آخرین نرخ معتبر + تتر کش‌شده با نشان بازار بسته — بدون fetch جدید", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const fetchedCalls: string[] = [];
    const countingProvider = {
      name: "count",
      async fetchUsdTehran() {
        fetchedCalls.push("usd");
        return null;
      },
      async fetchMarketReport() {
        fetchedCalls.push("report");
        return USER_REPORT;
      },
    };

    // حالت بازار بسته — همهٔ روزها بسته
    const closedMarket = {
      timezone: "Asia/Tehran" as const,
      defaultSession: "closed",
      sessions: {
        closed: { windowsByDay: {}, holidays: [] },
      },
    };

    // ابتدا در بازار باز دادهٔ pinned بسازیم (با مرجعهای معتبر تا
    // تترِ مستقل هم منتشر و کش شود)
    await runUsdRefresh(env, {
      fetchFn: withRefs(fetchFn),
      provider: countingProvider,
      marketHours: {
        timezone: "Asia/Tehran",
        defaultSession: "open",
        sessions: {
          open: {
            windowsByDay: {
              0: [{ from: "00:00", to: "23:59" }],
              1: [{ from: "00:00", to: "23:59" }],
              2: [{ from: "00:00", to: "23:59" }],
              3: [{ from: "00:00", to: "23:59" }],
              4: [{ from: "00:00", to: "23:59" }],
              5: [{ from: "00:00", to: "23:59" }],
              6: [{ from: "00:00", to: "23:59" }],
            },
            holidays: [],
          },
        },
      },
    });
    const fetchCountBefore = fetchedCalls.length;

    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: countingProvider,
      marketHours: closedMarket,
    });

    expect(result.status).toBe("market-closed");
    // provider در بازار بسته صدا زده نشد
    expect(fetchedCalls.length).toBe(fetchCountBefore);
    // پیام جدید با نشان بازار بسته + همان نرخ‌های کش‌شده — بدون ویرایش
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(0);
    expect(sends).toHaveLength(2); // انتشار باز + پیام «گذار به بسته»
    expect(String(sends[1]?.body.text)).toContain("بازار بسته");
    expect(String(sends[1]?.body.text)).toContain("<b>266,200</b> معامله");
    expect(String(sends[1]?.body.text)).toContain("<b>266,350 تومان</b>");
    expect(sends[1]?.body.parse_mode).toBe("HTML");
  });

  it("بدون هیچ کش → no-data (MARKET_CLOSED_NO_CACHE)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv({ STATE: new MockKV() });
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: {
        timezone: "Asia/Tehran",
        defaultSession: "closed",
        sessions: { closed: { windowsByDay: {}, holidays: [] } },
      },
    });
    expect(result.status).toBe("no-data");
    expect(result.reason).toBe("MARKET_CLOSED_NO_CACHE");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
  });
});

describe("runUsdRefresh — صرفه‌جویی نوشتن KV", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("وضعیت هر اجرا فقط در تغییر می‌نویسد (نه هر اجرا)", async () => {
    const { fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const provider = fakeProvider(null, USER_REPORT);

    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    const statusWrites1 = kv.putCalls.filter(
      (c) => c.key === USD_STATUS_KEY,
    ).length;
    expect(statusWrites1).toBe(1);

    // اجراهای بعدی: پیام جدید می‌سازند اما وضعیت تکراری چیزی نمی‌نویسد
    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    const statusWrites2 = kv.putCalls.filter(
      (c) => c.key === USD_STATUS_KEY,
    ).length;
    expect(statusWrites2).toBe(1); // ok|<reason> یکسان — بدون نوشتن مجدد
  });
});
