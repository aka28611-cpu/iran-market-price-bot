import { describe, expect, it } from "vitest";
import { runMarketReport } from "../src/scheduler/report-job";
import { PAUSED_FLAG_KEY, REPORT_STATUS_KEY } from "../src/state";
import type { MarketReport } from "../src/types";
import {
  CHANNEL_ID,
  fakeProvider,
  makeEnv,
  MockKV,
  telegramRecorder,
} from "./helpers";

const NOW = () => new Date("2025-10-08T10:00:00Z");

const REPORT: MarketReport = {
  fetchedAt: "2025-10-08T09:30:00Z",
  source: "test",
  items: [
    { symbol: "usd", value: 253_000 },
    { symbol: "eur", value: null },
    { symbol: "gold18k", value: 41_500_000 },
    { symbol: "emami", value: 92_000_000 },
    { symbol: "quarterCoin", value: -1 }, // نامعتبر → حذف از گزارش
  ],
};

describe("runMarketReport — جاب ۶ ساعت (sendMessage جدید)", () => {
  it("نبود داده (stub) → هیچ تماسی با تلگرام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(makeEnv(), { fetchFn, now: NOW });
    expect(result.status).toBe("no-data");
    expect(calls).toHaveLength(0);
  });

  it("حالت pause → skipped بدون تماس", async () => {
    const kv = new MockKV();
    await kv.put(PAUSED_FLAG_KEY, "1");
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: NOW,
      provider: fakeProvider(null, REPORT),
    });
    expect(result.status).toBe("paused");
    expect(calls).toHaveLength(0);
  });

  it("فقط آیتمهای معتبر منتشر می‌شوند؛ نبود و نامعتبر حذف می‌شوند", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: NOW,
      provider: fakeProvider(null, REPORT),
    });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.chat_id).toBe(CHANNEL_ID);
    const text = String(calls[0]?.body.text);
    expect(text).toContain("دلار: ۲۵۳٬۰۰۰");
    expect(text).toContain("سکه امامی: ۹۲٬۰۰۰٬۰۰۰");
    expect(text).not.toContain("یورو:"); // نبود داده
    expect(text).not.toContain("ربع سکه:"); // مقدار نامعتبر
    const status = JSON.parse(kv.store.get(REPORT_STATUS_KEY) ?? "{}");
    expect(status.status).toBe("ok");
  });

  it("هیچ آیتم معتیری نبود → عدم انتشار (fail-closed)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const empty: MarketReport = {
      fetchedAt: "2025-10-08T09:30:00Z",
      source: "test",
      items: [{ symbol: "eur", value: null }],
    };
    const result = await runMarketReport(makeEnv(), {
      fetchFn,
      now: NOW,
      provider: fakeProvider(null, empty),
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("NO_VALID_ITEMS");
    expect(calls).toHaveLength(0);
  });

  it("خطای ارسال → send-error بدون throw", async () => {
    const failingFetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "Forbidden" }), {
        status: 403,
      })) as typeof fetch;
    const result = await runMarketReport(makeEnv(), {
      fetchFn: failingFetch,
      now: NOW,
      provider: fakeProvider(null, REPORT),
    });
    expect(result.status).toBe("send-error");
  });
});
