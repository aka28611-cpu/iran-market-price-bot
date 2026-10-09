import { beforeEach, describe, expect, it } from "vitest";
import { allowUser } from "../src/auth/access";
import {
  extractCallbackQuery,
  parseCommandInput,
} from "../src/auth/telegram-auth";
import { resetRateLimiterForTests } from "../src/ratelimit";
import {
  CONVERSATION_PREFIX,
  LAST_REPORT_KEY,
  TICKETS_COUNT_KEY,
  TICKETS_OPEN_KEY,
} from "../src/state";
import { handleTelegramUpdate } from "../src/telegram/commands";
import {
  allTexts,
  callbackUpdate,
  editedMessages,
  fakeProvider,
  makeEnv,
  MockKV,
  sentMessages,
  telegramRecorder,
  textUpdate,
  userUpdate,
} from "./helpers";

const USER_ID = 999111222;
const ADMIN_ID = 100200300;

function fakeReport() {
  return {
    items: [
      { symbol: "usd", value: 267_200, unit: "toman" },
      { symbol: "eur", value: 299_010, unit: "toman" },
      { symbol: "gold18k", value: 26_309_310, unit: "toman" },
    ] as Array<{ symbol: "usd"; value: number; unit: "toman" }>,
    fetchedAt: new Date().toISOString(),
    source: "fake",
  };
}

/** متن آخرین پیام (ارسالی یا ویرایشی) */
function lastText(calls: Array<{ url: string; body: Record<string, unknown> }>): string {
  const texts = allTexts(calls);
  return texts[texts.length - 1] ?? "";
}

describe("جریان /start — عضویت اجباری (سمت سرور)", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("کاربر غیرعضو → پیام عضویت + دکمه بررسی مجدد؛ getChatMember با کانال و کاربر درست", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });

    const membershipCall = calls.find((c) =>
      c.url.endsWith("/getChatMember"),
    );
    expect(membershipCall).toBeDefined();
    expect(membershipCall?.body.chat_id).toBe(env.CHANNEL_ID);
    expect(membershipCall?.body.user_id).toBe(USER_ID);

    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("عضو کانال شوید");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    // کانال خصوصی بدون CHANNEL_LINK → فقط دکمه بررسی مجدد (بدون URL ساختگی)
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].callback_data).toBe("rc");
    expect(markup.inline_keyboard[0][0].url).toBeUndefined();
  });

  it("کانال عمومی @username → دکمه عضویت با لینک استاندارد t.me", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv({ CHANNEL_ID: "@my_market_channel" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0][0].url).toBe(
      "https://t.me/my_market_channel",
    );
    expect(markup.inline_keyboard[0][0].text).toBe("📢 عضویت در کانال");
    expect(markup.inline_keyboard[1][0].callback_data).toBe("rc");
  });

  it("CHANNEL_LINK صریح → دکمه با همان لینک", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv({ CHANNEL_LINK: "https://t.me/join/abc123" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].url).toBe("https://t.me/join/abc123");
  });

  it("پیام عضویت بدون لینک، به دکمه عضویتِ غایب ارجاع نمیدهد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv(); // کانال خصوصی + CHANNEL_LINK خالی
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).not.toContain("۱) روی دکمه");
    expect(String(msgs[0]?.body.text)).toContain("بررسی مجدد");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].callback_data).toBe("rc");
  });

  it("کاربر عضو اما بدون مجوز → پیام محدودیت + دکمه ثبت تیکت (مسیر درخواست دسترسی)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ CHANNEL_LINK: "https://t.me/my_market_channel" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("فعال نیست");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    // دکمه ثبت تیکت = مسیر فرار پشتیبانی
    expect(markup.inline_keyboard[0][0].callback_data).toBe("tkn");
    expect(markup.inline_keyboard[1][0].url).toBe(
      "https://t.me/my_market_channel",
    );
  });

  it("SUPPORT_LINK خارجی → دکمه پشتیبانی با URL", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ SUPPORT_LINK: "https://t.me/support_bot" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    const urls = JSON.stringify(markup.inline_keyboard);
    expect(urls).toContain("https://t.me/support_bot");
  });

  it("خطای API عضویت ≠ عدم عضویت — پیام «بررسی ممکن نیست» بدون ادعای قطعی", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("نمیتوان عضویت شما را بررسی کرد");
    // هیچ ادعایی درباره عدم عضویت یا محدودیت دسترسی نیست
    expect(String(msgs[0]?.body.text)).not.toContain("فعال نیست");
  });

  it("دورزدن گات با دستور مستقیم ممکن نیست — /price غیرعضو → پیام عضویت", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "kicked" });
    const env = makeEnv();
    const provider = fakeProvider(null, fakeReport());
    await handleTelegramUpdate(userUpdate("/price"), env, {
      fetchFn,
      provider,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("عضو کانال شوید");
    expect(String(msgs[0]?.body.text)).not.toContain("گزارش بازار");
  });

  it("کاربر مجاز → /start منوی دکمهای + /price گزارش بازار + /status", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);

    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    await handleTelegramUpdate(userUpdate("/price"), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    await handleTelegramUpdate(userUpdate("/status"), env, { fetchFn });

    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("انتخاب کنید");
    const startMarkup = JSON.parse(String(msgs[0]?.body.reply_markup));
    const startButtons = JSON.stringify(startMarkup.inline_keyboard);
    expect(startButtons).toContain("px");
    expect(startButtons).toContain("tkn");
    expect(startButtons).not.toContain("پنل مدیریت");
    expect(String(msgs[1]?.body.text)).toContain("گزارش بازار ایران");
    // /price هم دکمه بازگشت به منو دارد
    const priceMarkup = JSON.parse(String(msgs[1]?.body.reply_markup));
    expect(JSON.stringify(priceMarkup.inline_keyboard)).toContain("home");
    expect(String(msgs[2]?.body.text)).toContain("وضعیت ربات");
  });

  it("/report آخرین گزارش ذخیرهشده را با مهر زمان نمایش میدهد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    const report = fakeReport();
    await kv.put(LAST_REPORT_KEY, JSON.stringify(report));

    await handleTelegramUpdate(userUpdate("/report"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("گزارش بازار ایران");
  });

  it("کاربر مجاز با stub → پیام صادقانه «در دسترس نیست» بدون قیمت جعلی", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    await handleTelegramUpdate(userUpdate("/price"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("در دسترس نیست");
    // هیچ عدد قیمت جعلی نمایش داده نمیشود
    expect(String(msgs[0]?.body.text)).not.toMatch(/\d{3}[،,]/);
  });

  it("متن نامربوط بدون مکالمه → راهنمای منو با دکمه 🏠", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("سلام"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("از منوی زیر");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].callback_data).toBe("home");
  });

  it("دستورات کاربر در گروه (chat ≠ from) بی‌پاسخ می‌مانند", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/start", USER_ID, -100999), env, {
      fetchFn,
    });
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("دستور ناشناس کاربر عادی بی‌پاسخ است", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/secret"), env, { fetchFn });
    expect(calls).toHaveLength(0);
  });
});

describe("پشتیبانی — مسیر فرار برای همه کاربران", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("/ticket <متن> برای کاربر غیرعضو هم کار میکند (بدون گات)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(userUpdate("/ticket مشکل دسترسی"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(2); // تأیید کاربر + اطلاع ادمین
    expect(String(msgs[0]?.body.text)).toContain("ثبت شد");
    expect(msgs[1]?.body.chat_id).toBe(ADMIN_ID);
    expect(
      JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]"),
    ).toHaveLength(1);
  });

  it("/ticket بدون متن → شروع جریان دکمهای (مرحله ۱: موضوع)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(userUpdate("/ticket"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("مرحله ۱");
    // مکالمه در KV ثبت شده با دکمه لغو
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].callback_data).toBe("cxl");
    expect(kv.store.get(`${CONVERSATION_PREFIX}${USER_ID}`)).toBeDefined();
  });

  it("/mytickets فقط تیکتهای خود کاربر را نشان میدهد (مالکیت سمت سرور)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(
      TICKETS_OPEN_KEY,
      JSON.stringify([
        {
          id: 1,
          userId: 777777777,
          subject: "موضوع دیگران",
          text: "تیکت شخص دیگری",
          createdAt: new Date().toISOString(),
          replies: [],
        },
        {
          id: 2,
          userId: USER_ID,
          subject: "موضوع من",
          text: "تیکت من",
          createdAt: new Date().toISOString(),
          replies: [],
        },
      ]),
    );
    await handleTelegramUpdate(userUpdate("/mytickets"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("باز شما");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    const markupJson = JSON.stringify(markup.inline_keyboard);
    expect(markupJson).toContain("tkv2");
    expect(markupJson).not.toContain("tkv1");
  });
});

describe("جریان کامل ثبت تیکت با دکمه (مکالمه KV)", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("tkn → موضوع → متن → تأیید → ثبت + اطلاع ادمین", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });

    // ۱) شروع جریان از دکمه (ویرایش همان پیام)
    await handleTelegramUpdate(callbackUpdate("tkn"), env, { fetchFn });
    let edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.message_id)).toBe("30");
    expect(String(edits[0]?.body.text)).toContain("مرحله ۱");

    // ۲) موضوع
    await handleTelegramUpdate(textUpdate("فعال‌سازی دسترسی"), env, { fetchFn });
    expect(lastText(calls)).toContain("مرحله ۲");
    expect(lastText(calls)).toContain("فعال‌سازی دسترسی");

    // ۳) متن پیام
    await handleTelegramUpdate(textUpdate("لطفاً دسترسی ربات را فعال کنید"), env, {
      fetchFn,
    });
    expect(lastText(calls)).toContain("تأیید");
    expect(lastText(calls)).toContain("لطفاً دسترسی ربات را فعال کنید");

    // ۴) تأیید از دکمه
    await handleTelegramUpdate(callbackUpdate("tkcf"), env, { fetchFn });
    expect(lastText(calls)).toContain("ثبت شد");
    expect(kv.store.get(TICKETS_COUNT_KEY)).toBe("1");

    // مکالمه پاک شده است
    expect(kv.store.get(`${CONVERSATION_PREFIX}${USER_ID}`)).toBeUndefined();

    // ادمین با دکمههای مدیریتی مطلع شد
    const msgs = sentMessages(calls);
    const adminMsg = msgs.find((m) => m.body.chat_id === ADMIN_ID);
    expect(adminMsg).toBeDefined();
    const adminMarkup = JSON.parse(String(adminMsg?.body.reply_markup));
    const adminButtons = JSON.stringify(adminMarkup.inline_keyboard);
    expect(adminButtons).toContain("adr1"); // دکمه پاسخ ادمین
    expect(adminButtons).toContain("adc1"); // دکمه بستن ادمین
  });

  it("موضوع بلند رد میشود و جریان در همان مرحله میماند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(callbackUpdate("tkn"), env, { fetchFn });
    await handleTelegramUpdate(textUpdate("x".repeat(81)), env, { fetchFn });
    expect(lastText(calls)).toContain("۸۰ کاراکتر");
    expect(lastText(calls)).toContain("مرحله ۱"); // همان مرحله
  });

  it("لغو (cxl) → مکالمه پاک + بازگشت به منوی اصلی", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(callbackUpdate("tkn"), env, { fetchFn });
    await handleTelegramUpdate(callbackUpdate("cxl"), env, { fetchFn });
    expect(lastText(calls)).toContain("انتخاب کنید");
    expect(kv.store.get(`${CONVERSATION_PREFIX}${USER_ID}`)).toBeUndefined();
  });

  it("پیام ویرایش‌شده (edited_message) در جریان نادیده گرفته میشود — پاسخ تکراری ثبت نمیشود", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(callbackUpdate("tkn"), env, { fetchFn });
    await handleTelegramUpdate(textUpdate("موضوع", USER_ID, USER_ID, 40, true), env, {
      fetchFn,
    });
    // هیچ مرحله جدیدی رندر نشد
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
  });

  it("دستور /start در میانهٔ جریان → مکالمه لغو و منو نمایش داده میشود", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    await handleTelegramUpdate(callbackUpdate("tkn"), env, { fetchFn });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    expect(kv.store.get(`${CONVERSATION_PREFIX}${USER_ID}`)).toBeUndefined();
    const msgs = sentMessages(calls);
    expect(String(msgs[msgs.length - 1]?.body.text)).toContain(
      "انتخاب کنید",
    );
  });
});

describe("Callback دکمهها — امنیت و مسیرها", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("rc (بررسی مجدد): غیرعضو → ویرایش همان پیام به پیام عضویت؛ answerCallbackQuery همیشه صدا زده میشود", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("rc"), env, {
      fetchFn,
    });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.message_id)).toBe("30"); // همان پیام ویرایش شد
    expect(String(edits[0]?.body.text)).toContain("عضو کانال شوید");
    expect(sentMessages(calls)).toHaveLength(0); // پیام جدیدی ارسال نشد
  });

  it("rc: عضو بدون مجوز → ویرایش به پیام محدودیت", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("rc"), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("فعال نیست");
  });

  it("rc: عضو مجاز → ویرایش به منوی اصلی", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, ADMIN_ID);
    await handleTelegramUpdate(callbackUpdate("rc"), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("انتخاب کنید");
    expect(String(edits[0]?.body.text)).not.toContain("پنل مدیریت");
  });

  it("rc از ادمین → منوی ادمین (با پنل مدیریت)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("rc", ADMIN_ID), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("انتخاب کنید");
    const markup = JSON.parse(String(edits[0]?.body.reply_markup));
    expect(JSON.stringify(markup.inline_keyboard)).toContain("پنل مدیریت");
  });

  it("px (قیمتها) فقط با گات — غیرعضو پیام عضویت میگیرد نه قیمت", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("px"), env, { fetchFn });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("عضو کانال شوید");
    expect(String(edits[0]?.body.text)).not.toContain("گزارش بازار");
  });

  it("data جعلی/ناشناس → فقط پاسخ تلگرام، بدون هیچ پیام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("hack:12345"), env, { fetchFn });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
    expect(editedMessages(calls)).toHaveLength(0);
  });

  it("callback در چت غیرخصوصی → فقط پاسخ تلگرام، بدون پیام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(
      callbackUpdate("rc", USER_ID, -100999),
      env,
      { fetchFn },
    );
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
    expect(editedMessages(calls)).toHaveLength(0);
  });

  it("دکمههای ادمین برای کاربر معمولی اجرا نمیشوند (adt بدون پیام)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("adt"), env, { fetchFn });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
    expect(editedMessages(calls)).toHaveLength(0);
  });

  it("callbackهای مکرر rate-limit میشوند", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    for (let i = 0; i < 25; i += 1) {
      await handleTelegramUpdate(callbackUpdate("rc"), env, {
        fetchFn,
      });
    }
    const edits = editedMessages(calls);
    expect(edits.length).toBeLessThan(25);
    expect(edits.length).toBeGreaterThanOrEqual(20);
  });

  it("tkv تیکت کاربر دیگر → «در دسترس شما نیست» (ملکیت سمت سرور)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(
      TICKETS_OPEN_KEY,
      JSON.stringify([
        {
          id: 1,
          userId: 777777777,
          subject: "s",
          text: "تیکت شخص دیگری",
          createdAt: new Date().toISOString(),
          replies: [],
        },
      ]),
    );
    await handleTelegramUpdate(callbackUpdate("tkv1"), env, { fetchFn });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("در دسترس شما نیست");
    expect(String(edits[0]?.body.text)).not.toContain("تیکت شخص دیگری");
  });
});

describe("گفتگوی تیکت — پاسخ و بستن با دکمه", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  function seedTicket(kv: MockKV, userId = USER_ID, id = 1) {
    return kv.put(
      TICKETS_OPEN_KEY,
      JSON.stringify([
        {
          id,
          userId,
          subject: "دسترسی",
          text: "لطفاً فعال کنید",
          createdAt: new Date().toISOString(),
          replies: [],
        },
      ]),
    );
  }

  it("پاسخ کاربر (tkr → متن) → ثبت پاسخ + اطلاع ادمین", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await seedTicket(kv);

    await handleTelegramUpdate(callbackUpdate("tkr1"), env, { fetchFn });
    expect(lastText(calls)).toContain("پاسخ به تیکت");

    await handleTelegramUpdate(textUpdate("ممنون، منتظرم"), env, { fetchFn });
    expect(lastText(calls)).toContain("گفتگو");
    expect(lastText(calls)).toContain("ممنون، منتظرم");

    // ادمین مطلع شد
    const msgs = sentMessages(calls);
    const adminMsg = msgs.find((m) => m.body.chat_id === ADMIN_ID);
    expect(adminMsg).toBeDefined();
    expect(String(adminMsg?.body.text)).toContain("پاسخ جدید کاربر");
  });

  it("پاسخ ادمین (adr → متن) → تحویل به چت کاربر با دکمههای پیگیری", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await seedTicket(kv);

    await handleTelegramUpdate(callbackUpdate("adr1", ADMIN_ID), env, { fetchFn });
    expect(lastText(calls)).toContain("پاسخ به تیکت");

    await handleTelegramUpdate(
      textUpdate("سلام! بررسی میشود", ADMIN_ID, ADMIN_ID, 50),
      env,
      { fetchFn },
    );
    // پیام تحویل به کاربر
    const msgs = sentMessages(calls);
    const userMsg = msgs.find((m) => m.body.chat_id === USER_ID);
    expect(userMsg).toBeDefined();
    expect(String(userMsg?.body.text)).toContain("پاسخ جدید پشتیبانی");
    const markup = JSON.parse(String(userMsg?.body.reply_markup));
    const buttons = JSON.stringify(markup.inline_keyboard);
    expect(buttons).toContain("tkr1"); // دکمه پاسخ کاربر روی همان تیکت
  });

  it("متن پاسخ ادمین فقط از خود ادمین پذیرفته میشود (جعل نقش رد)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await seedTicket(kv);

    // کاربر معمولی سعی میکند در جریان admin_reply (KV دستکاریشده) بنویسد
    await kv.put(
      `${CONVERSATION_PREFIX}${USER_ID}`,
      JSON.stringify({
        flow: "admin_reply",
        step: "text",
        ticketId: 1,
        promptMessageId: 30,
        promptChatId: USER_ID,
        updatedAt: new Date().toISOString(),
      }),
    );
    await handleTelegramUpdate(textUpdate("من ادمین نیستم"), env, { fetchFn });
    // پاسخ support ثبت نشد
    const open = JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]");
    expect(open[0]?.replies ?? []).toHaveLength(0);
  });

  it("بستن تیکت کاربر (tkc → tky) → تیکت بسته + اطلاع ادمین", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await seedTicket(kv);

    await handleTelegramUpdate(callbackUpdate("tkc1"), env, { fetchFn });
    expect(lastText(calls)).toContain("بسته شود؟");

    await handleTelegramUpdate(callbackUpdate("tky1"), env, { fetchFn });
    expect(lastText(calls)).toContain("بسته شد");
    expect(JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]")).toHaveLength(0);
    const adminNotified = sentMessages(calls).some(
      (m) => m.body.chat_id === ADMIN_ID,
    );
    expect(adminNotified).toBe(true);
  });

  it("tky روی تیکت بستهشده → پیام نامعتبر", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    // تیکتی وجود ندارد
    await handleTelegramUpdate(callbackUpdate("tky5"), env, { fetchFn });
    expect(lastText(calls)).toContain("معتبر نیست");
  });
});

describe("بازبینی مسیرهای حیاتی — پشتیبانی، قیمت، bypass و خطای API", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("کاربر عضوِ بدون مجوز /price نمیگیرد — پیام محدودیت، نه گزارش قیمت", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/price"), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("فعال نیست");
    expect(String(msgs[0]?.body.text)).not.toContain("گزارش بازار");
  });

  it("کاربر عضوِ بدون مجوز /report هم دریافت نمیکند (حتی با گزارش ذخیرهشده)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(LAST_REPORT_KEY, JSON.stringify(fakeReport()));
    await handleTelegramUpdate(userUpdate("/report"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("فعال نیست");
    expect(String(msgs[0]?.body.text)).not.toContain("گزارش بازار ایران");
  });

  it("کاربر عضوِ بدون مجوز میتواند تیکت ثبت کند — گیت Allowlist مسیر پشتیبانی را نمیبندد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(
      userUpdate("/ticket لطفاً دسترسی ربات را فعال کنید"),
      env,
      { fetchFn },
    );
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(2);
    expect(String(msgs[0]?.body.text)).toContain("ثبت شد");
    expect(msgs[1]?.body.chat_id).toBe(ADMIN_ID);
  });

  it("دکمه «📝 ثبت تیکت» برای کاربر بدون مجوز کار میکند (callback بدون گیت)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("tkn"), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("مرحله ۱");
    // مسیر پشتیبانی هرگز پیام محدودیت/عضویت نشان نمیدهد
    expect(String(edits[0]?.body.text)).not.toContain("فعال نیست");
  });

  it("callback جعلی با data «price» نمیتواند گیت دسترسی را دور بزند", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("price"), env, { fetchFn });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
    expect(editedMessages(calls)).toHaveLength(0);
  });

  it("callback با data «admin:100200300» هم دور زده نمیشود — نه پیام، نه اجرا", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("admin:100200300"), env, {
      fetchFn,
    });
    expect(sentMessages(calls)).toHaveLength(0);
    expect(editedMessages(calls)).toHaveLength(0);
  });

  it("خطای getChatMember در callback → «بررسی ممکن نیست» — نه عضویت، نه محدودیت", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: user not found",
    });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("rc"), env, {
      fetchFn,
    });
    const edits = editedMessages(calls);
    expect(String(edits[0]?.body.text)).toContain("نمیتوان عضویت شما را بررسی کرد");
    expect(String(edits[0]?.body.text)).not.toContain("فعال نیست");
    expect(String(edits[0]?.body.text)).not.toContain("عضو کانال شوید");
  });
});

describe("اعتبارسنجی ساختار callback و دستورهای آرگومندار", () => {
  it("callback ساختار خراب → null", () => {
    expect(extractCallbackQuery(null)).toBeNull();
    expect(extractCallbackQuery({})).toBeNull();
    expect(extractCallbackQuery({ callback_query: "not-record" })).toBeNull();
    expect(
      extractCallbackQuery({ callback_query: { id: "1" } }),
    ).toBeNull(); // بدون from/message/data
    expect(
      extractCallbackQuery({
        callback_query: {
          id: "1",
          from: { id: "fake-string-id" },
          message: { chat: { id: 123 } },
          data: "rc",
        },
      }),
    ).toBeNull();
    // بدون message_id قابل اعتماد → null (برای ویرایش امن همان پیام)
    expect(
      extractCallbackQuery({
        callback_query: {
          id: "1",
          from: { id: 5 },
          message: { chat: { id: 5 }, message_id: "not-number" },
          data: "rc",
        },
      }),
    ).toBeNull();
  });

  it("callback معتبر → اطلاعات با from.id و message_id سمت سرور", () => {
    const info = extractCallbackQuery(callbackUpdate("rc"));
    expect(info).not.toBeNull();
    expect(info?.fromId).toBe(USER_ID);
    expect(info?.chatId).toBe(USER_ID);
    expect(info?.messageId).toBe(30);
    expect(info?.data).toBe("rc");
  });

  it("parseCommandInput — دستور ساده و آرگومندار", () => {
    expect(parseCommandInput("/start")).toEqual({ name: "start", rest: "" });
    expect(parseCommandInput("/ticket hello world")).toEqual({
      name: "ticket",
      rest: "hello world",
    });
    expect(parseCommandInput("/allow@mybot 123")).toEqual({
      name: "allow",
      rest: "123",
    });
    expect(parseCommandInput("plain text")).toBeNull();
    expect(parseCommandInput("")).toBeNull();
  });
});
