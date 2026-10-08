import { describe, expect, it } from "vitest";
import type { PriceProvider } from "../src/providers/provider";
import {
  describeJobResult,
  runUsdRefresh,
} from "../src/scheduler/usd-job";
import {
  LAST_USD_PRICE_KEY,
  PAUSED_FLAG_KEY,
  USD_MESSAGE_ID_KEY,
  USD_STATUS_KEY,
} from "../src/state";
import {
  alwaysClosedMarketHours,
  alwaysOpenMarketHours,
  alwaysUnknownMarketHours,
  CHANNEL_ID,
  fakeProvider,
  fakeUsdPrice,
  makeEnv,
  MockKV,
  telegramRecorder,
} from "./helpers";

const NOW = () => new Date("2025-10-08T10:00:00Z");
const FRESH = "2025-10-08T09:59:30Z";

describe("runUsdRefresh — جاب ۱ دقیقه (editMessageText روی پیام ثابت)", () => {
  it("نبود داده (stub) → هیچ تماسی با تلگرام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("no-data");
    expect(calls).toHaveLength(0);
  });

  it("داده کهسته → invalid و عدم انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const stale = fakeUsdPrice({ updatedAt: "2025-10-08T08:00:00Z" });
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(stale),
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("STALE_DATA");
    expect(calls).toHaveLength(0);
  });

  it("خرید > فروش → invalid و عدم انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const badPrice = fakeUsdPrice({ buy: 260_000, sell: 254_000, updatedAt: FRESH });
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(badPrice),
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("BUY_GT_SELL");
    expect(calls).toHaveLength(0);
  });

  it("حالت pause → skipped بدون تماس", async () => {
    const kv = new MockKV();
    await kv.put(PAUSED_FLAG_KEY, "1");
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("paused");
    expect(calls).toHaveLength(0);
  });

  it("اولین اجرا: پیام جدید می‌سازد و id آن را ذخیره می‌کند", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("sendMessage");
    expect(calls[0]?.body.chat_id).toBe(CHANNEL_ID);
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("100");
    expect(
      JSON.parse(kv.store.get(LAST_USD_PRICE_KEY) ?? "{}").buy,
    ).toBe(253_000);
    const status = JSON.parse(kv.store.get(USD_STATUS_KEY) ?? "{}");
    expect(status.status).toBe("ok");
  });

  it("اجراهای بعدی: همان پیام را edit می‌کند — پیام جدید نمی‌سازد", async () => {
    const kv = new MockKV();
    await kv.put(USD_MESSAGE_ID_KEY, "100");
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("editMessageText");
    expect(calls[0]?.body.message_id).toBe(100);
    expect(calls[0]?.body.chat_id).toBe(CHANNEL_ID);
  });

  it("id خراب در KV → مسیر پیام جدید (نه خطا)", async () => {
    const kv = new MockKV();
    await kv.put(USD_MESSAGE_ID_KEY, "not-a-number");
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("ok");
    expect(calls[0]?.url).toContain("sendMessage");
  });

  it("خطای ارسال تلگرام → send-error بدون throw", async () => {
    const failingFetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
        { status: 400 },
      )) as typeof fetch;
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn: failingFetch,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("send-error");
    expect(result.reason).toContain("chat not found");
  });

  it("خطای شبکه تلگرام → send-error با نگاشت NETWORK", async () => {
    const throwingFetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn: throwingFetch,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
    });
    expect(result.status).toBe("send-error");
    expect(result.reason).toBe("NETWORK");
  });

  it("استثنای provider → provider-error و عدم انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const provider = {
      name: "err",
      async fetchUsdTehran(): Promise<never> {
        throw new Error("upstream down");
      },
      async fetchMarketReport() {
        return null;
      },
    };
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      marketHours: alwaysOpenMarketHours(),
      provider,
    });
    expect(result.status).toBe("provider-error");
    expect(calls).toHaveLength(0);
  });
});

describe("runUsdRefresh — ساعت بازار (OPEN / CLOSED / UNKNOWN)", () => {
  it("UNKNOWN → provider صدا زده نمی‌شود و هیچ تماسی با تلگرام نیست", async () => {
    const { calls, fetchFn } = telegramRecorder();
    let providerCalled = false;
    const provider: PriceProvider = {
      name: "spy",
      async fetchUsdTehran() {
        providerCalled = true;
        return fakeUsdPrice({ updatedAt: FRESH });
      },
      async fetchMarketReport() {
        return null;
      },
    };
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      provider,
      marketHours: alwaysUnknownMarketHours(),
    });
    expect(result.status).toBe("market-unknown");
    expect(result.reason).toBe("MARKET_HOURS_UNKNOWN");
    expect(providerCalled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("CLOSED + نبود کش → no-data بدون تماس (MARKET_CLOSED_NO_CACHE)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
      marketHours: alwaysClosedMarketHours(),
    });
    expect(result.status).toBe("no-data");
    expect(result.reason).toBe("MARKET_CLOSED_NO_CACHE");
    expect(calls).toHaveLength(0);
  });

  it("CLOSED + کش معتبر → edit همان پیام با متن «بازار بسته» (بدون fetch جدید)", async () => {
    const kv = new MockKV();
    await kv.put(USD_MESSAGE_ID_KEY, "100");
    // داده کهنه‌تر از ۱۰ دقیقه — در حالت CLOSED مجاز است (نمایش آخرین قیمت معتبر)
    const cached = fakeUsdPrice({ updatedAt: "2025-10-08T09:00:00Z" });
    await kv.put(LAST_USD_PRICE_KEY, JSON.stringify(cached));
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      provider: fakeProvider(fakeUsdPrice({ updatedAt: FRESH })),
      marketHours: alwaysClosedMarketHours(),
    });
    expect(result.status).toBe("market-closed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("editMessageText");
    expect(calls[0]?.body.message_id).toBe(100);
    expect(String(calls[0]?.body.text)).toContain("بازار بسته است");
    expect(String(calls[0]?.body.text)).toContain("۲۵۳٬۰۰۰");
    // کش (آخرین قیمت معتبر) بازنویسی نمی‌شود
    expect(
      JSON.parse(kv.store.get(LAST_USD_PRICE_KEY) ?? "{}").updatedAt,
    ).toBe("2025-10-08T09:00:00Z");
  });

  it("CLOSED + کش خراب (خرید > فروش) → invalid بدون انتشار", async () => {
    const kv = new MockKV();
    const cached = fakeUsdPrice({
      buy: 999,
      sell: 100,
      updatedAt: "2025-10-08T09:00:00Z",
    });
    await kv.put(LAST_USD_PRICE_KEY, JSON.stringify(cached));
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysClosedMarketHours(),
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("CLOSED_BUY_GT_SELL");
    expect(calls).toHaveLength(0);
  });

  it("CLOSED + نبود message_id → پیام جدید می‌سازد و id ذخیره می‌کند", async () => {
    const kv = new MockKV();
    const cached = fakeUsdPrice({ updatedAt: "2025-10-08T09:00:00Z" });
    await kv.put(LAST_USD_PRICE_KEY, JSON.stringify(cached));
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runUsdRefresh(env, {
      fetchFn,
      now: NOW,
      marketHours: alwaysClosedMarketHours(),
    });
    expect(result.status).toBe("market-closed");
    expect(calls[0]?.url).toContain("sendMessage");
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("100");
  });

  it("describeJobResult پیامهای حالتهای بازار را دارد", () => {
    expect(describeJobResult({ status: "market-closed" })).toContain(
      "بازار بسته است",
    );
    expect(describeJobResult({ status: "market-unknown" })).toContain(
      "نامشخص",
    );
  });
});
