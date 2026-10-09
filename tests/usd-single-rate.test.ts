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
 * اصول fail-closed حفظ میشود: بدون داده = بدون انتشار، بدون مقدار جایگزین.
 */

const USER_REPORT: MarketReport = {
  items: [
    { symbol: "usd", value: 266_200, unit: "toman" },
    { symbol: "eur", value: 299_010, unit: "toman" },
  ],
  fetchedAt: new Date().toISOString(),
  source: "fake-single",
  dataDate: new Date().toISOString(),
};

describe("runUsdRefresh — مسیر تک‌نرخی", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("provider بدون میز خرید/فروش → نرخ واحد از گزارش بازار منتشر میشود", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const provider = fakeProvider(null, USER_REPORT);

    const result = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    // اولین اجرا: sendMessage به کانال (پیام ثابت جدید)
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.chat_id).toBe(env.CHANNEL_ID);
    expect(String(sent[0]?.body.text)).toContain("نرخ دلار");
    expect(String(sent[0]?.body.text)).toContain("۲۶۶٬۲۰۰");
    // بدون ساخت buy/sell از نرخ واحد
    expect(String(sent[0]?.body.text)).not.toContain("خرید:");
    expect(String(sent[0]?.body.text)).not.toContain("فروش:");
    expect(String(sent[0]?.body.text)).toContain("بدون میز خرید/فروش");
    // دادهٔ pinned ذخیره شد
    expect(kv.store.has(PIN_TEXT_KEY)).toBe(true);
    expect(kv.store.has(PIN_DATA_KEY)).toBe(true);
    expect(kv.store.has(USD_MESSAGE_ID_KEY)).toBe(true);
  });

  it("اجرای دوم با دادهٔ یکسان → ویرایش نمیکند (UNCHANGED — صرفهٔ KV/Telegram)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const provider = fakeProvider(null, USER_REPORT);

    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    expect(result.reason).toBe("UNCHANGED");
    // فقط یک فراخوانی sendMessage (پیام اول) — هیچ editMessageText اضافه نشد
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(0);
  });

  it("تغییر نرخ → ویرایش همان پیام (editMessageText با message_id ذخیرهشده)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });

    await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    const changed: MarketReport = {
      ...USER_REPORT,
      items: [
        { symbol: "usd", value: 270_000, unit: "toman" },
        { symbol: "eur", value: 299_010, unit: "toman" },
      ],
    };
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, changed),
      marketHours: alwaysOpenMarketHours(),
    });

    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined();
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.message_id)).toBe("100");
    expect(String(edits[0]?.body.text)).toContain("۲۷۰٬۰۰۰");
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

  it("نمایش آخرین نرخ معتبر با نشان بازار بسته — بدون fetch جدید", async () => {
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

    // ابتدا در بازار باز دادهٔ pinned بسازیم
    await runUsdRefresh(env, {
      fetchFn,
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
    // ویرایش پیام ثابت با نشان بازار بسته
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("بازار بسته");
    expect(String(edits[0]?.body.text)).toContain("آخرین نرخ معتبر");
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

describe("runUsdRefresh — صرفهجویی نوشتن KV", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("وضعیت ake run فقط در تغییر مینویسد (نه هر اجرا)", async () => {
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

    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    }); // UNCHANGED
    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    }); // UNCHANGED
    const statusWrites2 = kv.putCalls.filter(
      (c) => c.key === USD_STATUS_KEY,
    ).length;
    expect(statusWrites2).toBe(2); // ok → ok/UNCHANGED گذار؛ اجرای سوم چیزی نمینویسد
  });
});
