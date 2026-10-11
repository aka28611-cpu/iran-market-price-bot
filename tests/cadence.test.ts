import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { handleScheduled, REPORT_CRON, USD_CRON } from "../src/scheduler/cron";
import { runMarketReport } from "../src/scheduler/report-job";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import { USD_LAST_EVENT_KEY, USD_MESSAGE_ID_KEY } from "../src/state";
import type { MarketReport } from "../src/types";
import {
  alwaysOpenMarketHours,
  fakeProvider,
  makeEnv,
  MockKV,
  telegramRecorder,
} from "./helpers";

/**
 * مدل «پیام جدید» — پوشش الزامات مأموریت راند ۲۸ (۲۰۲۶-۱۰-۱۱):
 *  ۱) دو اجرای معتبر پنج‌دقیقه‌ای → دو پیام جدید؛ پیام قبلی ویرایش نمی‌شود
 *  ۲) اجرای مجدد «همان رویداد» → پیام مضاعف ساخته نمی‌شود (suppressed)
 *  ۳) رویداد بعدی (۵ دقیقه بعد، قیمت یکسان) → پیام جدید
 *  ۴) گزارش شش‌ساعته → همیشه پیام جدید
 *  ۵) تلاقی گزارش شش‌ساعته با پیام پنج‌دقیقه‌ای → هر دو ارسال
 *  ۶) هیچ editMessageText / deleteMessage در مسیر انتشار
 *
 * cross-check اینجا غیرفعال است تا تست روی «زمان‌بندی پیام» متمرکز
 * بماند؛ صحت داده و fail-closed بودن در cross-check.test.ts و
 * public-output.test.ts پوشش داده شده است.
 */

const REPORT_ITEMS: MarketReport = {
  items: [
    { symbol: "usd", value: 266_200, unit: "toman" },
    { symbol: "usdt", value: 266_350, unit: "toman" },
    { symbol: "emami", value: 92_000_000, unit: "toman" },
  ],
  fetchedAt: "2026-10-11T08:00:00Z",
  source: "fake-cadence",
  dataDate: "2026-10-11T08:00:00Z",
};

/** رویدادهای Cron پنج‌دقیقه‌ای — ۱۲:۰۰ و ۱۲:۰۵ UTC؛ گزارش بعدی ۱۸:۰۰ */
const T0 = Date.parse("2026-10-11T12:00:00Z");
const T1 = T0 + 5 * 60_000; // رویداد پنج‌دقیقه‌ای بعدی
const T6H = T0 + 6 * 60 * 60_000; // رویداد گزارش شش‌ساعتهٔ بعدی

function makeCadenceEnv(kv: MockKV) {
  return makeEnv({ CROSS_CHECK_ENABLED: false, STATE: kv });
}

describe("مدل پیام جدید — جاب پنج‌دقیقه‌ای", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("دو اجرای معتبر پنج‌دقیقه‌ای → دو پیام جدید؛ پیام قبلی هرگز ویرایش نمی‌شود", async () => {
    const { calls, fetchFn } = telegramRecorder({
      autoIncrementMessageIds: true,
    });
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);

    const r1 = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
      scheduledTime: T0,
    });
    const r2 = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T1),
      scheduledTime: T1,
    });

    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(sends).toHaveLength(2); // هر اجرا یک پیام جدید
    expect(edits).toHaveLength(0); // پیام قبلی ویرایش/حذف نشد
    // قیمت یکسان — اما دو پیام مجزا با شناسه‌های متفاوت
    expect(String(sends[1]?.body.text)).toBe(String(sends[0]?.body.text));
    // آخرین id ثبت شد (مشاهده/وریفای — نه ویرایش)
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("101");
    expect(kv.store.get(USD_LAST_EVENT_KEY)).toBe(JSON.stringify(T1));
  });

  it("اجرای مجدد همان رویداد → پیام مضاعف ساخته نمی‌شود (suppressed)", async () => {
    const { calls, fetchFn } = telegramRecorder({
      autoIncrementMessageIds: true,
    });
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);

    const first = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
      scheduledTime: T0,
    });
    // اجرای مجدد «همان رویداد» — delivery تکراری Cron، دیرتر از اجرای اول
    const replay = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0 + 20_000),
      scheduledTime: T0,
    });

    expect(first.status).toBe("ok");
    expect(replay.status).toBe("suppressed");
    expect(replay.reason).toBe("DUPLICATE_SAME_EVENT");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(1); // فقط پیام اول — مضاعف نشد
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("100");
  });

  it("بعد از اجرای مجدد، رویداد بعدی → پیام جدید (استمرار زمان‌بندی)", async () => {
    const { calls, fetchFn } = telegramRecorder({
      autoIncrementMessageIds: true,
    });
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);

    await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
      scheduledTime: T0,
    });
    const replay = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0 + 20_000),
      scheduledTime: T0,
    });
    const next = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T1),
      scheduledTime: T1,
    });

    expect(replay.status).toBe("suppressed");
    expect(next.status).toBe("ok"); // رویداد جدید → انتشار ادامه دارد
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(2);
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("101");
  });

  it("فراخوانی دستی بدون scheduledTime → بدون گارد رویداد (قفل مشورتی فقط هم‌زمانی را می‌گیرد)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);
    // مثل /refresh ادمین: دو فراخوانی متوالی سالم (بدون قفل فعال)
    const r1 = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    const r2 = await runUsdRefresh(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
    });
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(
      calls.filter((c) => c.url.endsWith("/sendMessage")),
    ).toHaveLength(2);
    expect(
      calls.filter((c) => c.url.endsWith("/editMessageText")),
    ).toHaveLength(0);
  });
});

describe("گزارش شش‌ساعته — پیام جدید", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("دو اجرای شش‌ساعته → دو پیام گزارش جدید؛ بدون ویرایش", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);

    const r1 = await runMarketReport(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
    });
    const r2 = await runMarketReport(env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T6H),
    });

    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok"); // ۶ ساعت > پنجرهٔ ۳۰ دقیقهٔ ضدتکرار
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(2); // هر گزارش = پیام جدید
    expect(
      calls.filter((c) => c.url.endsWith("/editMessageText")),
    ).toHaveLength(0);
  });

  it("تلاقی گزارش شش‌ساعته با پیام پنج‌دقیقه‌ای → هر دو پیام طبق برنامهٔ خود ارسال می‌شوند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeCadenceEnv(kv);
    const provider = fakeProvider(null, REPORT_ITEMS);

    // ۱۲:۰۰ UTC: هر دو cron فایر می‌شوند — dispatch واقعی با handleScheduled
    await handleScheduled(USD_CRON, env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
      scheduledTime: T0,
    });
    await handleScheduled(REPORT_CRON, env, {
      fetchFn,
      provider,
      marketHours: alwaysOpenMarketHours(),
      now: () => new Date(T0),
      scheduledTime: T0,
    });

    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    const edits = calls.filter((c) => c.url.endsWith("/editMessageText"));
    expect(sends).toHaveLength(2); // ۱ پیام دلار + ۱ گزارش
    expect(edits).toHaveLength(0); // هیچ ویرایشی
    // یکی پیام قالب دلار است و دیگری گزارش کامل بازار
    const texts = sends.map((c) => String(c.body.text));
    expect(texts.some((t) => t.includes("دلار فردایی تهران"))).toBe(true);
    expect(texts.some((t) => t.includes("گزارش بازار"))).toBe(true);
  });
});
