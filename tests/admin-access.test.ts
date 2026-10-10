import { beforeEach, describe, expect, it } from "vitest";
import { allowUser } from "../src/auth/access";
import { isAuthorizedAdmin } from "../src/auth/telegram-auth";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { handleTelegramUpdate } from "../src/telegram/commands";
import {
  allTexts,
  callbackUpdate,
  editedMessages,
  fakeProvider,
  makeEnv,
  MockKV,
  telegramRecorder,
  textUpdate,
} from "./helpers";

/**
 * تست‌های واقعی و واحد دسترسی ادمین — خواستهٔ کاربر (مشکل ۱، بند ۷):
 *  ۱) ادمین اصلی: /start → منوی ادمین (پنل مدیریت) بدون هیچ گات
 *  ۲) کاربر عادی: /start → گات عضویت/مجوز (منوی ادمین هرگز نمایش نمییابد)
 *  ۳) کاربرِ افزوده‌شده (allowlist): مجاز اما «ادمین نیست» — نه منوی ادمین، نه اجرای عملیات ادمین
 *  ۴) Callback جعلی: data جعلی/ادمین‌نما برای کاربر عادی → fail-closed
 *  ۵) رگرسیون قفل ادمین: خطای بررسی عضویت (getChatMember) نباید ادمین را از
 *     قیمت‌ها/وضعیت قفل کند — جدا بودن عضویت از مجوز ادمین (بند ۶ خواسته)
 */

const USER_ID = 999111222;
const ADMIN_ID = 100200300;

function fakeReport() {
  return {
    items: [
      { symbol: "usd", value: 267_200, unit: "toman" },
      { symbol: "gold18k", value: 26_309_310, unit: "toman" },
    ] as Array<{ symbol: "usd"; value: number; unit: "toman" }>,
    fetchedAt: new Date().toISOString(),
    source: "fake",
  };
}

describe("دسترسی ادمین — مسیر کامل از update تا منو", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  // ---------- ۱) ادمین اصلی ----------

  it("ادمین اصلی: /start → منوی ادمین با «👑 پنل مدیریت» — بدون گات عضویت/مجوز", async () => {
    // getChatMember خطا میدهد (ربات ادمین کانال نیست) — ادمین نباید قفل شود
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(textUpdate("/start", ADMIN_ID, ADMIN_ID), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    const texts = allTexts(calls);
    // متن اختصاصی مسیر ادمین + دکمهٔ «پنل مدیریت» در کیبورد
    expect(texts.some((t) => String(t).includes("دستورات متنی مدیریتی"))).toBe(
      true,
    );
    const sent = calls.find((c) => c.url.endsWith("/sendMessage"));
    const markup = JSON.parse(String(sent?.body.reply_markup));
    expect(
      JSON.stringify(markup.inline_keyboard).includes("پنل مدیریت"),
    ).toBe(true);
    // هیچ getChatMember برای ادمین صدا زده نشد — عضویت از مجوز ادمین جدا است
    expect(calls.some((c) => c.url.endsWith("/getChatMember"))).toBe(false);
  });

  it("ادمین اصلی با KV خالی: هیچ رکورد ادمین در KV لازم نیست (env تنها منبع)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(textUpdate("/start", ADMIN_ID, ADMIN_ID), env, {
      fetchFn,
    });
    const sent = calls.find((c) => c.url.endsWith("/sendMessage"));
    const markup = JSON.parse(String(sent?.body.reply_markup));
    expect(
      JSON.stringify(markup.inline_keyboard).includes("پنل مدیریت"),
    ).toBe(true);
  });

  it("isAuthorizedAdmin — تطابق عددی دقیق؛ شناسهٔ دیگر رد میشود", () => {
    expect(isAuthorizedAdmin(ADMIN_ID, ADMIN_ID)).toBe(true);
    expect(isAuthorizedAdmin(ADMIN_ID + 1, ADMIN_ID)).toBe(false);
    expect(isAuthorizedAdmin(ADMIN_ID - 1, ADMIN_ID)).toBe(false);
  });

  // ---------- ۲) کاربر عادی ----------

  it("کاربر عادی عضوِ بدون مجوز: /start → پیام محدودیت؛ بدون «پنل مدیریت»", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(textUpdate("/start", USER_ID, USER_ID), env, {
      fetchFn,
    });
    const texts = allTexts(calls).map(String);
    expect(texts.some((t) => t.includes("فعال نیست"))).toBe(true);
    expect(texts.some((t) => t.includes("پنل مدیریت"))).toBe(false);
  });

  // ---------- ۳) کاربر افزوده‌شده (allowlist) — مجاز اما نه ادمین ----------

  it("کاربر افزودهشده: مجاز است اما منوی ادمین نمیگیرد (پنل مدیریت ندارد)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    await handleTelegramUpdate(textUpdate("/start", USER_ID, USER_ID), env, {
      fetchFn,
    });
    const texts = allTexts(calls).map(String);
    expect(texts.some((t) => t.includes("قیمت بازار ایران"))).toBe(true);
    expect(texts.some((t) => t.includes("پنل مدیریت"))).toBe(false);
    const sent = calls.find((c) => c.url.endsWith("/sendMessage"));
    const markup = sent ? JSON.parse(String(sent.body.reply_markup)) : null;
    expect(
      JSON.stringify(markup?.inline_keyboard ?? []).includes("پنل مدیریت"),
    ).toBe(false);
  });

  it("کاربر افزودهشده: دکمه ادمین (admin_home) برایش اجرا نمیشود — fail-closed", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    await handleTelegramUpdate(callbackUpdate("ad", USER_ID), env, {
      fetchFn,
    });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(editedMessages(calls)).toHaveLength(0);
    expect(
      allTexts(calls).some((t) => String(t).includes("پنل مدیریت")),
    ).toBe(false);
  });

  // ---------- ۴) Callback جعلی ----------

  it("callback جعلی با data admin از کاربر عادی → هیچ پیام/ویرایشی (فقط answerCallbackQuery)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(callbackUpdate("ad", USER_ID), env, {
      fetchFn,
    });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(editedMessages(calls)).toHaveLength(0);
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(0);
  });

  it("callback با data جعلی/نامعتبر → fail-closed بدون هیچ پاسخ محتوایی", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(
      callbackUpdate("admin:100200300", USER_ID),
      env,
      { fetchFn },
    );
    expect(editedMessages(calls)).toHaveLength(0);
    expect(
      calls.filter((c) => c.url.endsWith("/sendMessage")),
    ).toHaveLength(0);
  });

  // ---------- ۵) رگرسیون: خطای عضویت ادمین را قفل نمیکند ----------

  it("ادمین + خطای getChatMember: دکمه «قیمتهای بازار» کار میکند (قفل نمیشود)", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Forbidden: bot is not a member of the channel chat",
    });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(callbackUpdate("px", ADMIN_ID), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("دلار");
    // متن «نمیتوان عضویت را بررسی کرد» برای ادمین ظاهر نمیشود
    expect(String(edits[0]?.body.text)).not.toContain("نمیتوان عضویت");
  });

  it("ادمین + خطای getChatMember: دکمه «وضعیت ربات» کار میکند (قفل نمیشود)", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(callbackUpdate("st", ADMIN_ID), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("وضعیت ربات");
    expect(String(edits[0]?.body.text)).not.toContain("نمیتوان عضویت");
  });

  it("کاربر عادی + همان خطای getChatMember: همچنان مسدود (fail-closed حفظ شد)", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    const env = makeEnv({ STATE: new MockKV() });
    await handleTelegramUpdate(callbackUpdate("px", USER_ID), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("نمیتوان عضویت");
    expect(String(edits[0]?.body.text)).not.toContain("دلار");
  });
});
