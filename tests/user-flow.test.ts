import { beforeEach, describe, expect, it } from "vitest";
import { allowUser } from "../src/auth/access";
import {
  extractCallbackQuery,
  parseCommandInput,
} from "../src/auth/telegram-auth";
import { resetRateLimiterForTests } from "../src/ratelimit";
import {
  LAST_REPORT_KEY,
  TICKETS_OPEN_KEY,
} from "../src/state";
import { handleTelegramUpdate } from "../src/telegram/commands";
import {
  callbackUpdate,
  fakeProvider,
  makeEnv,
  MockKV,
  sentMessages,
  telegramRecorder,
  userUpdate,
} from "./helpers";

const USER_ID = 999111222;

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

describe("جریان /start — عضویت اجباری (سمت سرور)", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("کاربر غیرعضو → پیام عضویت + دکمه بررسی؛ getChatMember با کانال و کاربر درست", async () => {
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
    expect(String(msgs[0]?.body.text)).toContain("عضو کانال قیمت ارز");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    // کانال خصوصی بدون CHANNEL_LINK → فقط دکمه بررسی (بدون URL ساختگی)
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].callback_data).toBe("check_membership");
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
    expect(markup.inline_keyboard[0][0].text).toBe(
      "📊 عضویت در کانال قیمت ارز",
    );
    expect(markup.inline_keyboard[1][0].callback_data).toBe(
      "check_membership",
    );
  });

  it("CHANNEL_LINK صریح → دکمه با همان لینک", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv({ CHANNEL_LINK: "https://t.me/join/abc123" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].url).toBe("https://t.me/join/abc123");
  });

  it("کاربر عضو اما بدون مجوز → متن دقیق محدودیت + دو دکمه", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ CHANNEL_LINK: "https://t.me/my_market_channel" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toBe(
      [
        "⚠️ دسترسی غیرمجاز",
        "",
        "عضویت شما در کانال تأیید شد، اما امکان استفاده مستقیم از امکانات این ربات برای حساب شما فعال نیست.",
        "",
        "📊 برای مشاهده قیمت‌های ارز و دریافت آخرین به‌روزرسانی‌ها، به کانال رسمی مراجعه کنید.",
        "",
        "🎫 برای درخواست دسترسی یا پیگیری مشکل، با پشتیبانی تماس بگیرید.",
      ].join("\n"),
    );
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].url).toBe(
      "https://t.me/my_market_channel",
    );
    expect(markup.inline_keyboard[1][0].callback_data).toBe("support_start");
  });

  it("SUPPORT_LINK خارجی → دکمه پشتیبانی با URL", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv({ SUPPORT_LINK: "https://t.me/support_bot" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard[0][0].url).toBe("https://t.me/support_bot");
  });

  it("خطای API عضویت ≠ عدم عضویت — پیام «بررسی ممکن نیست» بدون ادعای قطعی", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain(
      "امکان بررسی عضویت شما وجود ندارد",
    );
    // هیچ ادعایی درباره عدم عضویت یا محدودیت دسترسی نیست
    expect(String(msgs[0]?.body.text)).not.toContain("دسترسی غیرمجاز");
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
    expect(String(msgs[0]?.body.text)).toContain("عضو کانال قیمت ارز");
    expect(String(msgs[0]?.body.text)).not.toContain("گزارش بازار");
  });

  it("کاربر مجاز → خوش‌آمد + /price گزارش بازار + /status", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, 100200300);

    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    await handleTelegramUpdate(userUpdate("/price"), env, {
      fetchFn,
      provider: fakeProvider(null, fakeReport()),
    });
    await handleTelegramUpdate(userUpdate("/status"), env, { fetchFn });

    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("خوش آمدید");
    expect(String(msgs[1]?.body.text)).toContain("گزارش بازار ایران");
    expect(String(msgs[2]?.body.text)).toContain("وضعیت ربات");
  });

  it("/report آخرین گزارش ذخیرهشده را با مهر زمان نمایش میدهد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, 100200300);
    const report = fakeReport();
    await kv.put(LAST_REPORT_KEY, JSON.stringify(report));

    await handleTelegramUpdate(userUpdate("/report"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("گزارش بازار ایران");
  });

  it("کاربر مجاز با stub → پیام صادقانه «داده‌ای دریافت نشد» بدون قیمت جعلی", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, 100200300);
    await handleTelegramUpdate(userUpdate("/price"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("داده‌ای");
    expect(String(msgs[0]?.body.text)).toContain("stub");
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

  it("/ticket برای کاربر غیرعضو هم کار میکند (بدون گات)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await handleTelegramUpdate(userUpdate("/ticket مشکل دسترسی"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(2); // تأیید کاربر + اطلاع ادمین
    expect(String(msgs[0]?.body.text)).toContain("#1");
    expect(msgs[1]?.body.chat_id).toBe(100200300);
    expect(JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]")).toHaveLength(1);
  });

  it("/ticket بدون متن → راهنما", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(userUpdate("/ticket"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("برای ثبت تیکت");
  });

  it("/mytickets فقط تیکتهای خود کاربر را نشان میدهد (مالکیت سمت سرور)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    // تیکت کاربر دیگر با نوشتن مستقیم در KV (شبیه state قبلی)
    await kv.put(
      TICKETS_OPEN_KEY,
      JSON.stringify([
        {
          id: 1,
          userId: 777777777,
          text: "تیکت شخص دیگری",
          createdAt: new Date().toISOString(),
        },
        {
          id: 2,
          userId: USER_ID,
          text: "تیکت من",
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    await handleTelegramUpdate(userUpdate("/mytickets"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("تیکت من");
    expect(String(msgs[0]?.body.text)).not.toContain("تیکت شخص دیگری");
  });
});

describe("Callback دکمهها — امنیت و مسیرها", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("check_membership: غیرعضو → پیام عضویت؛ answerCallbackQuery همیشه صدا زده میشود", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("check_membership"), env, {
      fetchFn,
    });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("عضو کانال قیمت ارز");
  });

  it("check_membership: عضو بدون مجوز → پیام محدودیت", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("check_membership"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("دسترسی غیرمجاز");
  });

  it("check_membership: عضو مجاز → خوش‌آمد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await allowUser(kv, USER_ID, 100200300);
    await handleTelegramUpdate(callbackUpdate("check_membership"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("خوش آمدید");
  });

  it("support_start → راهنمای تیکت (بدون گات عضویت)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("support_start"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("پشتیبانی و ثبت تیکت");
    expect(String(msgs[0]?.body.text)).toContain("/ticket");
  });

  it("data جعلی/ناشناس → فقط پاسخ تلگرام، بدون هیچ پیام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("hack:12345"), env, { fetchFn });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("callback در چت غیرخصوصی → فقط پاسخ تلگرام، بدون پیام", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(
      callbackUpdate("check_membership", USER_ID, -100999),
      env,
      { fetchFn },
    );
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("callback ادمین → بدون پیام (ادمین این دکمهها را دریافت نمیکند)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const env = makeEnv();
    await handleTelegramUpdate(
      callbackUpdate("check_membership", 100200300),
      env,
      { fetchFn },
    );
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("callbackهای مکرر rate-limit میشوند", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    for (let i = 0; i < 25; i += 1) {
      await handleTelegramUpdate(callbackUpdate("check_membership"), env, {
        fetchFn,
      });
    }
    const msgs = sentMessages(calls);
    expect(msgs.length).toBeLessThan(25);
    expect(msgs.length).toBeGreaterThanOrEqual(20);
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
    expect(String(msgs[0]?.body.text)).toContain("دسترسی غیرمجاز");
    expect(String(msgs[0]?.body.text)).not.toContain("گزارش بازار");
  });

  it("کاربر عضوِ بدون مجوز /report هم دریافت نمیکند (حتی با گزارش ذخیرهشده)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(LAST_REPORT_KEY, JSON.stringify(fakeReport()));
    await handleTelegramUpdate(userUpdate("/report"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("دسترسی غیرمجاز");
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
    expect(msgs).toHaveLength(2); // تأیید کاربر + اطلاع ادمین
    expect(String(msgs[0]?.body.text)).toContain("#1");
    expect(msgs[1]?.body.chat_id).toBe(100200300);
    expect(
      JSON.parse(kv.store.get(TICKETS_OPEN_KEY) ?? "[]"),
    ).toHaveLength(1);
  });

  it("دکمه «🎫 پشتیبانی و ثبت تیکت» برای کاربر بدون مجوز کار میکند (callback بدون گیت)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("support_start"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]?.body.text)).toContain("پشتیبانی و ثبت تیکت");
    // مسیر پشتیبانی هرگز پیام محدودیت/عضویت نشان نمیدهد
    expect(String(msgs[0]?.body.text)).not.toContain("دسترسی غیرمجاز");
  });

  it("callback جعلی با data «price» نمیتواند گیت دسترسی را دور بزند", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("price"), env, { fetchFn });
    expect(
      calls.some((c) => c.url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("callback با data «admin:100200300» هم دور زده نمیشود — نه پیام، نه اجرا", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "member" });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("admin:100200300"), env, {
      fetchFn,
    });
    expect(sentMessages(calls)).toHaveLength(0);
  });

  it("خطای getChatMember در callback → «بررسی ممکن نیست» — نه عضویت، نه محدودیت", async () => {
    const { calls, fetchFn } = telegramRecorder({
      memberError: "Bad Request: user not found",
    });
    const env = makeEnv();
    await handleTelegramUpdate(callbackUpdate("check_membership"), env, {
      fetchFn,
    });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("امکان بررسی عضویت");
    expect(String(msgs[0]?.body.text)).not.toContain("دسترسی غیرمجاز");
    expect(String(msgs[0]?.body.text)).not.toContain("برای استفاده از امکانات");
  });

  it("پیام عضویت بدون لینک، به دکمه عضویتِ غایب ارجاع نمیدهد (رفتار مشخص، بدون بنبست)", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv(); // کانال خصوصی + CHANNEL_LINK خالی
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    // متن مسیر ادامه دارد: «بررسی عضویت» هنوز توصیه میشود
    expect(String(msgs[0]?.body.text)).toContain("✅ بررسی عضویت");
    expect(String(msgs[0]?.body.text)).not.toContain("۱) روی دکمه");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].callback_data).toBe(
      "check_membership",
    );
  });

  it("پیام عضویت با لینک، دستور دکمه عضویت را دارد", async () => {
    const { calls, fetchFn } = telegramRecorder({ memberStatus: "left" });
    const env = makeEnv({ CHANNEL_ID: "@my_market_channel" });
    await handleTelegramUpdate(userUpdate("/start"), env, { fetchFn });
    const msgs = sentMessages(calls);
    expect(String(msgs[0]?.body.text)).toContain("۱) روی دکمه");
    const markup = JSON.parse(String(msgs[0]?.body.reply_markup));
    expect(markup.inline_keyboard).toHaveLength(2);
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
          data: "check_membership",
        },
      }),
    ).toBeNull();
  });

  it("callback معتبر → اطلاعات با from.id سمت سرور", () => {
    const info = extractCallbackQuery(callbackUpdate("check_membership"));
    expect(info).not.toBeNull();
    expect(info?.fromId).toBe(USER_ID);
    expect(info?.chatId).toBe(USER_ID);
    expect(info?.data).toBe("check_membership");
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
