import { describe, expect, it } from "vitest";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import {
  LAST_USD_PRICE_KEY,
  PAUSED_FLAG_KEY,
  USD_MESSAGE_ID_KEY,
  USD_STATUS_KEY,
} from "../src/state";
import {
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
    const result = await runUsdRefresh(makeEnv(), { fetchFn, now: NOW });
    expect(result.status).toBe("no-data");
    expect(calls).toHaveLength(0);
  });

  it("داده کهسته → invalid و عدم انتشار", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const stale = fakeUsdPrice({ updatedAt: "2025-10-08T08:00:00Z" });
    const result = await runUsdRefresh(makeEnv(), {
      fetchFn,
      now: NOW,
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
      provider,
    });
    expect(result.status).toBe("provider-error");
    expect(calls).toHaveLength(0);
  });
});
