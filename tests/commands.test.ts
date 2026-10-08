import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { PAUSED_FLAG_KEY } from "../src/state";
import { handleTelegramUpdate } from "../src/telegram/commands";
import {
  adminUpdate,
  CHANNEL_ID,
  fakeProvider,
  fakeUsdPrice,
  makeEnv,
  MockKV,
  telegramRecorder,
} from "./helpers";

describe("دستورات ادمین — authorization و مقصد پیام", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("فرستنده غیرادمین کاملاً بی‌پاسخ است (fail-closed)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/start", 999, 999), env, {
      fetchFn,
    });
    expect(calls).toHaveLength(0);
  });

  it("/start فهرست دستورات را به چت ادمینِ احرازشده می‌فرستد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/start"), env, { fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.chat_id).toBe(100200300);
    expect(String(calls[0]?.body.text)).toContain("/status");
    expect(String(calls[0]?.body.text)).toContain("/pause");
  });

  it("/test فقط به CHANNEL_ID پیکربندی‌شده منتشر می‌کند — نه چت فرستنده", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    // چت فرستنده عمداً متفاوت از CHANNEL_ID است
    await handleTelegramUpdate(adminUpdate("/test", 100200300, 777), env, {
      fetchFn,
    });
    expect(calls).toHaveLength(2);
    // ۱) پیام انتشار آزمایشی: فقط به کانال پیکربندی‌شده
    expect(calls[0]?.body.chat_id).toBe(CHANNEL_ID);
    expect(String(calls[0]?.body.text)).toContain("اتصال کانال برقرار است");
    // ۲) تأییدیه نتیجه: به چت ادمینِ احرازشده
    expect(calls[1]?.body.chat_id).toBe(777);
    // متن «اتصال کانال برقرار است» فقط به مقصد کانال می‌رود
    for (const call of calls) {
      if (String(call.body.text).includes("اتصال کانال برقرار است")) {
        expect(call.body.chat_id).toBe(CHANNEL_ID);
      }
    }
  });

  it("/pause و /resume فلگ KV را قطع/وصل می‌کنند", async () => {
    const { fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(adminUpdate("/pause"), env, { fetchFn });
    expect(kv.store.get(PAUSED_FLAG_KEY)).toBe("1");
    await handleTelegramUpdate(adminUpdate("/resume"), env, { fetchFn });
    expect(kv.store.has(PAUSED_FLAG_KEY)).toBe(false);
  });

  it("/update با provider پیش‌فرض (stub) چیزی منتشر نمی‌کند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/update"), env, { fetchFn });
    // فقط یک پیام «گزارش نتیجه» به ادمین — هیچ ارسالی به کانال
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.chat_id).toBe(100200300);
    expect(String(calls[0]?.body.text)).toContain("داده‌ای");
  });

  it("/price داده تازه provider را فقط برای ادمین نمایش می‌دهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    const provider = fakeProvider(fakeUsdPrice());
    await handleTelegramUpdate(adminUpdate("/price"), env, {
      fetchFn,
      provider,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.chat_id).toBe(100200300);
    expect(String(calls[0]?.body.text)).toContain("دلار فردایی تهران");
  });

  it("/price داده نامعتبر را نمایش نمی‌دهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    const provider = fakeProvider(
      fakeUsdPrice({ buy: 999, sell: 100, updatedAt: "2020-01-01T00:00:00Z" }),
    );
    await handleTelegramUpdate(adminUpdate("/price"), env, {
      fetchFn,
      provider,
    });
    expect(String(calls[0]?.body.text)).toContain("معتبر نیست");
  });

  it("دستور ناشناس بی‌پاسخ است", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/foobar"), env, { fetchFn });
    expect(calls).toHaveLength(0);
  });

  it("update خراب بدون خطا نادیده گرفته می‌شود", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate({ bad: "shape" }, env, { fetchFn });
    await handleTelegramUpdate(null, env, { fetchFn });
    expect(calls).toHaveLength(0);
  });

  it("دستورات مکرر ادمین rate-limit می‌شوند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    for (let i = 0; i < 25; i += 1) {
      await handleTelegramUpdate(adminUpdate("/start"), env, { fetchFn });
    }
    // سقف ۲۰ در دقیقه — عده‌ای بی‌پاسخ می‌مانند
    expect(calls.length).toBeLessThan(25);
    expect(calls.length).toBeGreaterThanOrEqual(20);
  });
});
