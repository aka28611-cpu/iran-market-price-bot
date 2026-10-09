import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { ALLOW_LIST_KEY, PAUSED_FLAG_KEY, TICKETS_OPEN_KEY } from "../src/state";
import { handleTelegramUpdate } from "../src/telegram/commands";
import {
  adminUpdate,
  callbackUpdate,
  CHANNEL_ID,
  fakeProvider,
  fakeUsdPrice,
  makeEnv,
  MockKV,
  sentMessages,
  telegramRecorder,
  userUpdate,
} from "./helpers";

/** متن آخرین پیام (ارسال یا ویرایش) */
function lastTextOf(
  calls: Array<{ url: string; body: Record<string, unknown> }>,
): string {
  const msgs = [
    ...sentMessages(calls),
    ...calls.filter((c) => c.url.endsWith("/editMessageText")),
  ];
  return String(msgs[msgs.length - 1]?.body.text ?? "");
}

describe("دستورات ادمین — authorization و مقصد پیام", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("فرستنده غیرادمین دستور مدیریتی نمی‌گیرد — پیام محدودیت بدون داده", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    // هیچ داده مدیریتی/قیمتی افشا نمیشود — فقط پیام محدودیت
    expect(String(msgs[0]?.body.chat_id)).toBe("999111222");
    expect(String(msgs[0]?.body.text)).not.toContain("/pause");
    expect(String(msgs[0]?.body.text)).not.toContain("/update");
  });

  it("/start فهرست دستورات را به چت ادمینِ احرازشده می‌فرستد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/start"), env, { fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.chat_id).toBe(100200300);
    expect(String(calls[0]?.body.text)).toContain("انتخاب کنید");
    expect(String(calls[0]?.body.text)).toContain("مدیریتی");
    // منوی ادمین دکمه پنل مدیریت دارد
    const markup = JSON.parse(String(calls[0]?.body.reply_markup));
    expect(JSON.stringify(markup.inline_keyboard)).toContain("پنل مدیریت");
  });

  it("/test فقط به CHANNEL_ID منتشر میکند — ادمین در چت خصوصی", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/test"), env, {
      fetchFn,
    });
    const testMsgs = sentMessages(calls);
    expect(testMsgs).toHaveLength(2);
    expect(testMsgs[0]?.body.chat_id).toBe(CHANNEL_ID);
    expect(String(testMsgs[0]?.body.text)).toContain("اتصال کانال برقرار است");
    expect(testMsgs[1]?.body.chat_id).toBe(100200300);
    for (const call of testMsgs) {
      if (String(call.body.text).includes("اتصال کانال برقرار است")) {
        expect(call.body.chat_id).toBe(CHANNEL_ID);
      }
    }
  });

  it("دستور ادمین در چت غیرخصوصی کاملاً بیپاسخ است (نشت به گروه ممنوع)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/test", 100200300, -100999), env, {
      fetchFn,
    });
    expect(calls).toHaveLength(0);
    expect(sentMessages(calls)).toHaveLength(0);
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

describe("مدیریت دسترسی و تیکت — دستورات ادمین", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("/allow کاربر را به فهرست مجاز اضافه و /users نمایش میدهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(adminUpdate("/allow 999111222"), env, { fetchFn });
    const stored = JSON.parse(kv.store.get(ALLOW_LIST_KEY) ?? "[]");
    expect(stored).toContain(999111222);
    await handleTelegramUpdate(adminUpdate("/users"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs.at(-1)?.body.text)).toContain("999111222");
  });

  it("/allow تکراری و /allow ادمین رد میشوند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(adminUpdate("/allow 999111222"), env, { fetchFn });
    await handleTelegramUpdate(adminUpdate("/allow 999111222"), env, { fetchFn });
    await handleTelegramUpdate(adminUpdate("/allow 100200300"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[1]?.body.text)).toContain("از قبل");
    expect(String(msgs[2]?.body.text)).toContain("ادمین");
    expect(JSON.parse(kv.store.get(ALLOW_LIST_KEY) ?? "[]")).toEqual([
      999111222,
    ]);
  });

  it("/allow با ورودی نامعتبر پیام راهنما میدهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/allow abc"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("نامعتبر");
  });

  it("/revoke دسترسی کاربر را حذف میکند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(adminUpdate("/allow 999111222"), env, { fetchFn });
    await handleTelegramUpdate(adminUpdate("/revoke 999111222"), env, { fetchFn });
    expect(JSON.parse(kv.store.get(ALLOW_LIST_KEY) ?? "[]")).toEqual([]);
  });

  it("دستورات مدیریتی برای کاربر عادی بی‌پاسخ است (حفظ fail-closed)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/allow 999111222"), env, { fetchFn });
    await handleTelegramUpdate(userUpdate("/revoke 999111222"), env, { fetchFn });
    await handleTelegramUpdate(userUpdate("/users"), env, { fetchFn });
    expect(calls).toHaveLength(0);
  });

  it("ادمین با Allowlist خالی همه دستورات مدیریتی را اجرا میکند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV(); // Allowlist خالی — نباید هیچ دستوری مسدود شود
    const env = makeEnv({ STATE: kv });
    const adminCommands = [
      "/start",
      "/status",
      "/price",
      "/update",
      "/users",
      "/tickets",
      "/pause",
      "/resume",
      "/test",
      "/allow 999111222",
      "/revoke 999111222",
      "/ticket_close 1",
    ];
    for (const cmd of adminCommands) {
      const before = sentMessages(calls).length;
      await handleTelegramUpdate(adminUpdate(cmd), env, { fetchFn });
      // هر دستور مدیریتی پاسخی تولید میکند — هیچی مسدود نیست
      expect(
        sentMessages(calls).length,
        `دستور ${cmd} نباید مسدود شود`,
      ).toBeGreaterThan(before);
    }
  });

  it("/status ادمین تنظیمات ناقص (بدون لینک کانال/پشتیبانی) را اعلام میکند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv(); // کانال خصوصی + CHANNEL_LINK/SUPPORT_LINK خالی
    await handleTelegramUpdate(adminUpdate("/status"), env, { fetchFn });
    const text = String(sentMessages(calls)[0]?.body.text);
    expect(text).toContain("لینک عمومی کانال پیکربندی نشده");
    expect(text).toContain("SUPPORT_LINK خالی");
  });

  it("/status با کانال عمومی @username هشدار لینک نمیدهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv({ CHANNEL_ID: "@my_market_channel" });
    await handleTelegramUpdate(adminUpdate("/status"), env, { fetchFn });
    const text = String(sentMessages(calls)[0]?.body.text);
    expect(text).not.toContain("لینک عمومی کانال پیکربندی نشده");
  });

  it("جریان کامل تیکت: ثبت کاربر → اطلاع ادمین → /tickets → بستن → اطلاع کاربر", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });

    // کاربر (بدون عضویت) تیکت میسازد — مسیر فرار پشتیبانی
    await handleTelegramUpdate(
      userUpdate("/ticket لطفاً دسترسی ربات را فعال کنید"),
      env,
      { fetchFn },
    );
    const stored = JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].userId).toBe(999111222);

    // اطلاع ادمین ارسال شده است
    const notify = sentMessages(calls).find(
      (m) => m.body.chat_id === 100200300,
    );
    expect(notify).toBeDefined();
    expect(String(notify?.body.text)).toContain("تیکت جدید");
    expect(String(notify?.body.text)).toContain("فعال کنید");
    const notifyMarkup = JSON.parse(String(notify?.body.reply_markup));
    const notifyButtons = JSON.stringify(notifyMarkup.inline_keyboard);
    expect(notifyButtons).toContain("adr1");
    expect(notifyButtons).toContain("adc1");

    // ادمین فهرست را میبیند
    await handleTelegramUpdate(adminUpdate("/tickets"), env, { fetchFn });
    const listMsg = sentMessages(calls).find((m) =>
      String(m.body.text).includes("باز (۱)"),
    );
    expect(listMsg).toBeDefined();
    const listMarkup = JSON.parse(String(listMsg?.body.reply_markup));
    expect(JSON.stringify(listMarkup.inline_keyboard)).toContain("adv1");
    await handleTelegramUpdate(
      callbackUpdate("adv1", 100200300),
      env,
      { fetchFn },
    );
    const detailText = lastTextOf(calls);
    expect(detailText).toContain("کاربر:");
    expect(detailText).toContain("فعال کنید");

    // بستن + اطلاع کاربر
    await handleTelegramUpdate(adminUpdate("/ticket_close 1"), env, {
      fetchFn,
    });
    expect(JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]")).toEqual([]);
    const closeMsgs = sentMessages(calls).filter((m) =>
      String(m.body.text).includes("بسته شد"),
    );
    expect(closeMsgs.length).toBeGreaterThanOrEqual(2); // کاربر + ادمین
  });

  it("/ticket_close با شماره ناموجود خطای مشخص میدهد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(adminUpdate("/ticket_close 99"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("پیدا نشد");
  });
});
