import type { Env } from "../env";
import {
  allowUser,
  checkChannelMembership,
  isUserAllowed,
  listAllowedUsers,
  revokeUser,
} from "../auth/access";
import { isAllowedPublishTarget } from "../auth/allowlist";
import {
  extractCallbackQuery,
  extractUpdateMessage,
  isAuthorizedAdmin,
  parseCommandInput,
  type TelegramCallbackInfo,
  type TelegramMessageInfo,
} from "../auth/telegram-auth";
import { faMoney, faTimestamp } from "../datetime";
import { logError, logInfo, logWarn } from "../logging";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
} from "../market-hours";
import { getProvider } from "../providers/registry";
import { rateLimit } from "../ratelimit";
import {
  isPaused,
  readLastReport,
  readLastUsdPrice,
  readJson,
  REPORT_STATUS_KEY,
  setPaused,
  USD_STATUS_KEY,
  type RunStatus,
} from "../state";
import {
  closeTicket,
  createTicket,
  listOpenTickets,
  listUserTickets,
} from "../support/tickets";
import { sanitizeReportItems, validateUsdPrice } from "../validation";
import { TelegramClient } from "./client";
import { formatMarketReport, formatUsdMessage } from "./format";
import {
  runUsdRefresh,
  describeJobResult,
  type JobDeps,
} from "../scheduler/usd-job";

/**
 * پردازش updateهای Telegram.
 *
 * جریان جدید (کاربران غیرادمین):
 *  1) استخراج امن message / callback_query (اعتبارسنجی ساختار)
 *  2) ادمین: دستورات مدیریتی (مثل قبل) + مدیریت دسترسی + تیکتها
 *  3) پشتیبانی (مسیر فرار — برای همه کاربران، حتی غیرمجاز): /ticket، /mytickets
 *  4) دستورات محافظت‌شده کاربر (/start /price /report /status):
 *     گات ۱: عضویت کانال (سمت سرور getChatMember — سه‌حالته)
 *     گات ۲: مجوز (allowlist در KV — عضویت به‌تنهایی مجوز نیست)
 *
 * امنیت:
 *  • هر دو گات روی «هر» فراخوانی دستور/callback سمت سرور اعمال میشود
 *  • شناسه کاربر فقط از from.id خود update — هرگز از data پیام
 *  • جریانهای کاربر فقط در چت خصوصی (chat.id === from.id) — بدون نشت به گروه
 *  • پاسخ دستورات همیشه به چت فرستنده؛ انتشار فقط به CHANNEL_ID (allowlist)
 */

const START_TEXT = [
  "🤖 ربات قیمت بازار ایران",
  "",
  "دستورات ادمین:",
  "/status — وضعیت ربات",
  "/price — قیمت لحظه‌ای دلار فردایی",
  "/update — بروزرسانی فوری پیام کانال",
  "/pause — توقف انتشار خودکار",
  "/resume — ادامه انتشار خودکار",
  "/test — ارسال پیام آزمایشی به کانال",
  "",
  "مدیریت دسترسی کاربران:",
  "/allow <user_id> — افزودن کاربر مجاز",
  "/revoke <user_id> — حذف دسترسی کاربر",
  "/users — فهرست کاربران مجاز",
  "",
  "پشتیبانی:",
  "/tickets — تیکت‌های باز",
  "/ticket_close <id> — بستن تیکت",
  "",
  "⚠️ دستورات مدیریتی فقط به ADMIN_USER_ID پاسخ می‌دهند.",
].join("\n");

const TEST_TEXT = "✅ پیام آزمایشی ربات قیمت بازار — اتصال کانال برقرار است.";

/** سقف دستورات هر کاربر در دقیقه */
const COMMAND_RATE_LIMIT = 20;
/** سقف callback هر کاربر در دقیقه */
const CALLBACK_RATE_LIMIT = 20;

/** اقدامهای مجاز callback — فقط «نوع اقدام»، بدون شناسه جاسازی‌شده */
const CALLBACK_CHECK_MEMBERSHIP = "check_membership";
const CALLBACK_SUPPORT_START = "support_start";

/** پیام عضویت وقتی دکمه لینک کانال موجود است */
const JOIN_TEXT_WITH_LINK = [
  "🔐 برای استفاده از امکانات این ربات، ابتدا باید عضو کانال قیمت ارز شوید.",
  "",
  "۱) روی دکمه «📊 عضویت در کانال قیمت ارز» بزنید و عضو شوید.",
  "۲) سپس دکمه «✅ بررسی عضویت» را بزنید تا وضعیت شما بررسی شود.",
  "",
  "تا زمان تأیید عضویت، امکانات محافظت‌شده ربات در دسترس شما نیست.",
].join("\n");

/**
 * پیام عضویت وقتی لینک کانال قابل تعیین نیست (کانال خصوصی + CHANNEL_LINK خالی)
 * — دکمه «عضویت» حذف شده و متن به آن ارجاع نمیدهد (بدون بنبست؛ مسیر ادامه دارد)
 */
const JOIN_TEXT_NO_LINK = [
  "🔐 برای استفاده از امکانات این ربات، ابتدا باید عضو کانال قیمت ارز شوید.",
  "",
  "لطفاً در تلگرام عضو کانال رسمی قیمت ارز شوید؛ سپس دکمه «✅ بررسی عضویت» را بزنید تا وضعیت شما بررسی شود.",
  "",
  "تا زمان تأیید عضویت، امکانات محافظت‌شده ربات در دسترس شما نیست.",
].join("\n");

const MEMBERSHIP_UNKNOWN_TEXT =
  "⚠️ در حال حاضر امکان بررسی عضویت شما وجود ندارد. لطفاً کمی بعد دوباره تلاش کنید.";

const RESTRICTED_TEXT = [
  "⚠️ دسترسی غیرمجاز",
  "",
  "عضویت شما در کانال تأیید شد، اما امکان استفاده مستقیم از امکانات این ربات برای حساب شما فعال نیست.",
  "",
  "📊 برای مشاهده قیمت‌های ارز و دریافت آخرین به‌روزرسانی‌ها، به کانال رسمی مراجعه کنید.",
  "",
  "🎫 برای درخواست دسترسی یا پیگیری مشکل، با پشتیبانی تماس بگیرید.",
].join("\n");

const SUPPORT_INSTRUCTIONS_TEXT = [
  "🎫 پشتیبانی و ثبت تیکت",
  "",
  "برای ثبت تیکت جدید، دستور زیر را بفرستید:",
  "/ticket <متن پیام>",
  "",
  "مثال:",
  "/ticket لطفاً دسترسی ربات را برایم فعال کنید",
  "",
  "برای پیگیری تیکت‌های خودتان: /mytickets",
  "",
  "تیکت‌های شما فقط برای ادمین ربات قابل مشاهده است.",
].join("\n");

const USER_WELCOME_TEXT = [
  "✅ خوش آمدید!",
  "",
  "دسترسی شما به ربات قیمت بازار ایران فعال است.",
  "",
  "دستورات:",
  "/price — قیمت‌های لحظه‌ای بازار",
  "/report — آخرین گزارش ذخیره‌شده",
  "/status — وضعیت ساده ربات",
  "/ticket — ثبت تیکت پشتیبانی",
  "/mytickets — پیگیری تیکت‌های شما",
  "",
  "📊 قیمت‌ها همچنین به‌صورت خودکار در کانال رسمی منتشر می‌شوند.",
].join("\n");

interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/** لینک عمومی کانال — از تنظیمات موجود؛ هرگز URL ساختگی */
function resolveChannelLink(env: Env): string {
  if (env.CHANNEL_LINK) return env.CHANNEL_LINK;
  // کانال عمومی با @username → لینک عمومی استاندارد
  if (env.CHANNEL_ID.startsWith("@")) {
    return `https://t.me/${env.CHANNEL_ID.slice(1)}`;
  }
  return ""; // کانال خصوصی بدون لینک → دکمه حذف می‌شود
}

/** پیام درخواست عضویت + دکمه‌ها */
function buildJoinKeyboard(env: Env): { inline_keyboard: InlineButton[][] } {
  const rows: InlineButton[][] = [];
  const link = resolveChannelLink(env);
  if (link) {
    rows.push([
      { text: "📊 عضویت در کانال قیمت ارز", url: link },
    ]);
  }
  rows.push([{ text: "✅ بررسی عضویت", callback_data: CALLBACK_CHECK_MEMBERSHIP }]);
  return { inline_keyboard: rows };
}

/** پیام محدودیت دسترسی + دو دکمه (طبق متن مصوب مالک) */
function buildRestrictedKeyboard(env: Env): {
  inline_keyboard: InlineButton[][];
} {
  const rows: InlineButton[][] = [];
  const link = resolveChannelLink(env);
  if (link) {
    rows.push([{ text: "📊 کانال قیمت ارز", url: link }]);
  }
  // پشتیبانی: لینک خارجی در صورت پیکربندی؛ وگرنه سیستم تیکت داخلی
  if (env.SUPPORT_LINK) {
    rows.push([{ text: "🎫 پشتیبانی و ثبت تیکت", url: env.SUPPORT_LINK }]);
  } else {
    rows.push([
      { text: "🎫 پشتیبانی و ثبت تیکت", callback_data: CALLBACK_SUPPORT_START },
    ]);
  }
  return { inline_keyboard: rows };
}

/** ارسال پیام درخواست عضویت — متن متناسب با وجود/نبود لینک کانال */
async function sendJoinPrompt(
  tg: TelegramClient,
  env: Env,
  chatId: number,
): Promise<void> {
  const text = resolveChannelLink(env)
    ? JOIN_TEXT_WITH_LINK
    : JOIN_TEXT_NO_LINK;
  await tg.sendMessage(chatId, text, {
    replyMarkup: buildJoinKeyboard(env),
  });
}

export async function handleTelegramUpdate(
  update: unknown,
  env: Env,
  deps: JobDeps = {},
): Promise<void> {
  try {
    // ۱) callback دکمهها — قبل از message
    const callback = extractCallbackQuery(update);
    if (callback) {
      await handleCallback(callback, env, deps);
      return;
    }

    const message = extractUpdateMessage(update);
    if (!message) return;

    const input = parseCommandInput(message.text);
    if (!input) return; // متن غیردستوری — بی‌پاسخ

    // ۲) ادمین — دستورات مدیریتی (رفتار قبلی حفظ شده + مدیریت جدید)
    if (isAuthorizedAdmin(message.fromId, env.ADMIN_USER_ID)) {
      await handleAdminCommand(message, input, env, deps);
      return;
    }

    // ۳) مسیر فرار پشتیبانی — برای همه کاربران، بدون گات عضویت/مجوز
    if (input.name === "ticket" || input.name === "mytickets") {
      if (!rateLimit(`tg:cmd:${message.fromId}`, COMMAND_RATE_LIMIT)) {
        logWarn("tg.command.rate_limited", { userId: message.fromId });
        return;
      }
      await handleSupportCommand(message, input, env, deps);
      return;
    }

    // ۴) دستورات محافظت‌شده کاربر — هر دو گات سمت سرور
    switch (input.name) {
      case "start":
      case "price":
      case "report":
      case "status":
        if (!rateLimit(`tg:cmd:${message.fromId}`, COMMAND_RATE_LIMIT)) {
          logWarn("tg.command.rate_limited", { userId: message.fromId });
          return;
        }
        await handleProtectedUserCommand(message, input, env, deps);
        return;
      default:
        // دستور ناشناس — بی‌پاسخ (عدم افشای فهرست دستورات)
        logInfo("tg.command.unknown", { command: input.name });
        return;
    }
  } catch (err) {
    logError("tg.update.error", {
      message: err instanceof Error ? err.message : "UNKNOWN",
    });
  }
}

// ---------- ادمین ----------

async function handleAdminCommand(
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
  deps: JobDeps,
): Promise<void> {
  if (!rateLimit(`tg:cmd:${message.fromId}`, COMMAND_RATE_LIMIT)) {
    logWarn("tg.command.rate_limited", { userId: message.fromId });
    return;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });

  switch (input.name) {
    case "start":
      await tg.sendMessage(message.chatId, START_TEXT);
      return;

    case "status":
      await tg.sendMessage(message.chatId, await buildStatusText(env));
      return;

    case "price":
      await tg.sendMessage(message.chatId, await buildAdminPriceText(env, deps));
      return;

    case "update": {
      const result = await runUsdRefresh(env, deps);
      await tg.sendMessage(message.chatId, describeJobResult(result));
      return;
    }

    case "pause":
      await setPaused(env.STATE, true);
      await tg.sendMessage(
        message.chatId,
        "⏸ انتشار خودکار متوقف شد. برای ادامه /resume بفرستید.",
      );
      return;

    case "resume":
      await setPaused(env.STATE, false);
      await tg.sendMessage(message.chatId, "▶️ انتشار خودکار ادامه یافت.");
      return;

    case "test": {
      const target = env.CHANNEL_ID;
      if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
        await tg.sendMessage(
          message.chatId,
          "❌ مقصد مجاز انتشار پیکربندی نشده است.",
        );
        return;
      }
      const sent = await tg.sendMessage(target, TEST_TEXT);
      await tg.sendMessage(
        message.chatId,
        sent.ok
          ? "✅ پیام آزمایشی به کانال ارسال شد."
          : `❌ ارسال به کانال ناموفق بود (${sent.error ?? "UNKNOWN"}).`,
      );
      return;
    }

    case "allow":
      await handleAllowCommand(tg, message, input, env);
      return;

    case "revoke":
      await handleRevokeCommand(tg, message, input, env);
      return;

    case "users": {
      const users = await listAllowedUsers(env.STATE);
      const text =
        users.length === 0
          ? "ℹ️ هنوز کاربر مجازی ثبت نشده است."
          : `👥 کاربران مجاز (${users.length}):\n${users.join("\n")}`;
      await tg.sendMessage(message.chatId, text);
      return;
    }

    case "tickets": {
      const tickets = await listOpenTickets(env.STATE);
      if (tickets.length === 0) {
        await tg.sendMessage(message.chatId, "ℹ️ تیکت بازی وجود ندارد.");
        return;
      }
      const lines = [`🎫 تیکت‌های باز (${tickets.length}):`];
      for (const t of tickets) {
        const preview =
          t.text.length > 80 ? `${t.text.slice(0, 80)}…` : t.text;
        lines.push(`#${t.id} — کاربر ${t.userId}`, preview, "");
      }
      await tg.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    case "ticket_close":
      await handleTicketCloseCommand(tg, message, input, env);
      return;

    default:
      logInfo("tg.command.unknown", { command: input.name });
      return;
  }
}

async function handleAllowCommand(
  tg: TelegramClient,
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
): Promise<void> {
  const userId = parseUserIdArg(input.rest);
  if (userId === null) {
    await tg.sendMessage(
      message.chatId,
      "❌ شناسه کاربر نامعتبر است. مثال: /allow 123456789",
    );
    return;
  }
  const result = await allowUser(env.STATE, userId, env.ADMIN_USER_ID);
  const text = result.ok
    ? `✅ کاربر ${userId} به فهرست دسترسی اضافه شد.`
    : result.reason === "ALREADY_ALLOWED"
      ? `ℹ️ کاربر ${userId} از قبل در فهرست دسترسی است.`
      : result.reason === "IS_ADMIN_ALREADY"
        ? "ℹ️ این شناسه ادمین است و نیازی به افزودن ندارد."
        : result.reason === "LIMIT_REACHED"
          ? "❌ سقف فهرست دسترسی پر است."
          : "❌ افزودن کاربر ناموفق بود.";
  await tg.sendMessage(message.chatId, text);
}

async function handleRevokeCommand(
  tg: TelegramClient,
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
): Promise<void> {
  const userId = parseUserIdArg(input.rest);
  if (userId === null) {
    await tg.sendMessage(
      message.chatId,
      "❌ شناسه کاربر نامعتبر است. مثال: /revoke 123456789",
    );
    return;
  }
  const result = await revokeUser(env.STATE, userId, env.ADMIN_USER_ID);
  const text = result.ok
    ? `✅ دسترسی کاربر ${userId} حذف شد.`
    : result.reason === "NOT_ALLOWED"
      ? `ℹ️ کاربر ${userId} در فهرست دسترسی نبود.`
      : result.reason === "IS_ADMIN"
        ? "❌ ادمین را نمی‌توان از فهرست حذف کرد."
        : "❌ حذف دسترسی ناموفق بود.";
  await tg.sendMessage(message.chatId, text);
}

async function handleTicketCloseCommand(
  tg: TelegramClient,
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
): Promise<void> {
  const ticketId = parseUserIdArg(input.rest);
  if (ticketId === null) {
    await tg.sendMessage(
      message.chatId,
      "❌ شماره تیکت نامعتبر است. مثال: /ticket_close 12",
    );
    return;
  }
  const result = await closeTicket(env.STATE, ticketId);
  if (!result.ok || !result.ticket) {
    await tg.sendMessage(
      message.chatId,
      `❌ تیکت #${ticketId} پیدا نشد (شاید قبلاً بسته شده باشد).`,
    );
    return;
  }
  // اطلاع به کاربر — چت خصوصی کاربر id اوست (تیکت را خودش در چت خصوصی ثبت کرده)
  const notified = await tg.sendMessage(
    result.ticket.userId,
    `🎫 تیکت #${ticketId} شما بسته شد. برای موضوع جدید /ticket بفرستید.`,
  );
  await tg.sendMessage(
    message.chatId,
    notified.ok
      ? `✅ تیکت #${ticketId} بسته شد و به کاربر اطلاع داده شد.`
      : `✅ تیکت #${ticketId} بسته شد؛ اما اطلاع‌رسانی به کاربر ناموفق بود.`,
  );
}

function parseUserIdArg(rest: string): number | null {
  if (!/^\d{1,15}$/.test(rest.trim())) return null;
  const value = Number(rest.trim());
  return Number.isSafeInteger(value) ? value : null;
}

// ---------- پشتیبانی (مسیر فرار — همه کاربران) ----------

async function handleSupportCommand(
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
  deps: JobDeps,
): Promise<void> {
  // فقط چت خصوصی — متن تیکت نباید در گروه ظاهر شود
  if (message.chatId !== message.fromId || message.fromId <= 0) {
    logInfo("tg.support.non-private", {});
    return;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });

  if (input.name === "ticket") {
    if (input.rest.length === 0) {
      await tg.sendMessage(
        message.chatId,
        "برای ثبت تیکت: /ticket <متن پیام>\nمثال: /ticket لطفاً دسترسی ربات را برایم فعال کنید",
      );
      return;
    }
    const result = await createTicket(env.STATE, message.fromId, input.rest);
    if (!result.ok || !result.ticket) {
      const text =
        result.reason === "TEXT_TOO_LONG"
          ? "❌ متن تیکت بیش از حد بلند است (حداکثر ۵۱۲ کاراکتر)."
          : result.reason === "USER_LIMIT_REACHED"
            ? "⚠️ شما ۳ تیکت باز دارید؛ لطفاً ابتدا منتظر پاسخ یا بسته‌شدن آن‌ها بمانید."
            : result.reason === "TOTAL_LIMIT_REACHED"
              ? "⚠️ ظرفیت صف تیکت‌ها پر است؛ لطفاً بعداً تلاش کنید."
              : "❌ ثبت تیکت ناموفق بود.";
      await tg.sendMessage(message.chatId, text);
      return;
    }
    await tg.sendMessage(
      message.chatId,
      `✅ تیکت #${result.ticket.id} ثبت شد.\nپشتیبانی به‌زودی بررسی می‌کند. پیگیری: /mytickets`,
    );
    // اطلاع ادمین — چت خصوصی ادمین
    await tg.sendMessage(
      env.ADMIN_USER_ID,
      `🎫 تیکت جدید #${result.ticket.id}\nاز کاربر: ${message.fromId}\n\n${result.ticket.text}`,
    );
    return;
  }

  // /mytickets — فقط تیکتهای خود کاربر (فیلتر سمت سرور)
  const { open, closedCount } = await listUserTickets(
    env.STATE,
    message.fromId,
  );
  if (open.length === 0) {
    await tg.sendMessage(
      message.chatId,
      closedCount > 0
        ? `شما تیکت بازی ندارید (${closedCount} تیکت بسته‌شده در تاریخچه).`
        : "شما هنوز تیکتی ثبت نکرده‌اید. ثبت: /ticket <متن پیام>",
    );
    return;
  }
  const lines = [`🎫 تیکت‌های باز شما (${open.length}):`];
  for (const t of open) {
    const preview = t.text.length > 80 ? `${t.text.slice(0, 80)}…` : t.text;
    lines.push(`#${t.id} — ${preview}`);
  }
  await tg.sendMessage(message.chatId, lines.join("\n"));
}

// ---------- دستورات محافظت‌شده کاربر (هر دو گات) ----------

async function handleProtectedUserCommand(
  message: TelegramMessageInfo,
  input: { name: string; rest: string },
  env: Env,
  deps: JobDeps,
): Promise<void> {
  // فقط چت خصوصی — دکمهها و پیامهای جریان کاربر
  if (message.chatId !== message.fromId || message.fromId <= 0) {
    logInfo("tg.command.non-private", {});
    return;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });

  // گات ۱: عضویت — سمت سرور، سه‌حالته
  const membership = await checkChannelMembership(message.fromId, env, deps);
  if (membership === "unknown") {
    // خطای API ≠ عدم عضویت — دسترسی مسدود، بدون ادعای قطعی
    await tg.sendMessage(message.chatId, MEMBERSHIP_UNKNOWN_TEXT);
    return;
  }
  if (membership === "not-member") {
    await sendJoinPrompt(tg, env, message.chatId);
    logInfo("tg.command.membership-required", {
      userId: message.fromId,
    });
    return;
  }

  // گات ۲: مجوز — عضویت به‌تنهایی مجوز نیست
  const allowed = await isUserAllowed(env.STATE, message.fromId);
  if (!allowed) {
    await tg.sendMessage(message.chatId, RESTRICTED_TEXT, {
      replyMarkup: buildRestrictedKeyboard(env),
    });
    logInfo("tg.command.denied", { userId: message.fromId });
    return;
  }

  switch (input.name) {
    case "start":
      await tg.sendMessage(message.chatId, USER_WELCOME_TEXT);
      return;
    case "price":
      await tg.sendMessage(message.chatId, await buildUserPriceText(env, deps));
      return;
    case "report":
      await tg.sendMessage(
        message.chatId,
        await buildUserCachedReportText(env),
      );
      return;
    case "status":
      await tg.sendMessage(message.chatId, await buildUserStatusText(env));
      return;
    default:
      logInfo("tg.command.unknown", { command: input.name });
      return;
  }
}

// ---------- Callback دکمهها ----------

async function handleCallback(
  callback: TelegramCallbackInfo,
  env: Env,
  deps: JobDeps,
): Promise<void> {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });

  // همیشه پاسخ — توقف نشانگر بارگذاری تلگرام (حتی در صورت رد)
  await tg.answerCallbackQuery(callback.id);

  // دکمههای ما فقط در چت خصوصی کاربر ارسال میشوند
  if (callback.chatId !== callback.fromId || callback.fromId <= 0) {
    logInfo("tg.callback.non-private", {});
    return;
  }

  // ادمین این دکمهها را دریافت نمیکند
  if (isAuthorizedAdmin(callback.fromId, env.ADMIN_USER_ID)) return;

  if (!rateLimit(`tg:cb:${callback.fromId}`, CALLBACK_RATE_LIMIT)) {
    logWarn("tg.callback.rate_limited", { userId: callback.fromId });
    return;
  }

  switch (callback.data) {
    case CALLBACK_CHECK_MEMBERSHIP: {
      // بررسی مجدد سمت سرور — هیچ اعتمادی به کلیک قبلی نیست
      const membership = await checkChannelMembership(
        callback.fromId,
        env,
        deps,
      );
      if (membership === "unknown") {
        await tg.sendMessage(callback.chatId, MEMBERSHIP_UNKNOWN_TEXT);
        return;
      }
      if (membership === "not-member") {
        await sendJoinPrompt(tg, env, callback.chatId);
        logInfo("tg.callback.membership-required", {
          userId: callback.fromId,
        });
        return;
      }
      const allowed = await isUserAllowed(env.STATE, callback.fromId);
      if (!allowed) {
        await tg.sendMessage(callback.chatId, RESTRICTED_TEXT, {
          replyMarkup: buildRestrictedKeyboard(env),
        });
        logInfo("tg.callback.denied", { userId: callback.fromId });
        return;
      }
      await tg.sendMessage(callback.chatId, USER_WELCOME_TEXT);
      return;
    }

    case CALLBACK_SUPPORT_START:
      // پشتیبانی برای همه — بدون گات عضویت/مجوز
      await tg.sendMessage(callback.chatId, SUPPORT_INSTRUCTIONS_TEXT);
      return;

    default:
      // data جعلی/ناشناس — فقط لاگ، بدون پاسخ اضافی
      logWarn("tg.callback.unknown-action", { data: callback.data });
      return;
  }
}

// ---------- متنهای وضعیت/قیمت ----------

async function buildStatusText(env: Env): Promise<string> {
  const paused = await isPaused(env.STATE);
  const usdStatus = await readJson<RunStatus>(env.STATE, USD_STATUS_KEY);
  const reportStatus = await readJson<RunStatus>(env.STATE, REPORT_STATUS_KEY);
  const lastPrice = await readLastUsdPrice(env.STATE);

  const lines = [
    "📊 وضعیت ربات",
    `وضعیت: ${paused ? "⏸ متوقف (pause)" : "✅ فعال"}`,
    `Provider: ${env.PRICE_PROVIDER}${
      env.PRICE_PROVIDER === "stub" ? " (بدون API واقعی — مرحله بعد)" : ""
    }`,
    `آخرین اجرای دلار: ${
      usdStatus
        ? `${faTimestamp(usdStatus.at)} — ${usdStatus.status}${
            usdStatus.reason ? ` (${usdStatus.reason})` : ""
          }`
        : "—"
    }`,
    `آخرین گزارش بازار: ${
      reportStatus
        ? `${faTimestamp(reportStatus.at)} — ${reportStatus.status}`
        : "—"
    }`,
  ];
  if (lastPrice) {
    lines.push(
      `آخرین قیمت دلار: خرید ${faMoney(lastPrice.buy)} | فروش ${faMoney(
        lastPrice.sell,
      )} | معامله ${faMoney(lastPrice.trade)}`,
    );
  }
  // اعلام تنظیمات ناقص — بدون این هشدار، حذف شدن دکمه عضویت بیصدا میماند
  if (resolveChannelLink(env) === "") {
    lines.push(
      "⚠️ لینک عمومی کانال پیکربندی نشده (CHANNEL_LINK خالی + کانال خصوصی) — دکمه «عضویت» حذف میشود",
    );
  }
  if (env.SUPPORT_LINK === "") {
    lines.push("ℹ️ SUPPORT_LINK خالی — دکمه پشتیبانی به سیستم تیکت داخلی وصل است");
  }
  return lines.join("\n");
}

/** قیمت لحظه‌ای ادمین — همان مسیر قبلی (دلار فردایی) */
async function buildAdminPriceText(
  env: Env,
  deps: JobDeps,
): Promise<string> {
  try {
    const provider = deps.provider ?? getProvider(env);
    const price = await provider.fetchUsdTehran();
    if (!price) {
      return `⚠️ فعلاً داده‌ای از provider دریافت نشد (provider: ${env.PRICE_PROVIDER}). هیچ مقدار جایگزین نمایش داده نمی‌شود.`;
    }
    const verdict = validateUsdPrice(price);
    if (!verdict.ok) {
      return `⚠️ داده دریافت شد اما معتبر نیست (${verdict.reason ?? "?"}) — نمایش داده نمی‌شود.`;
    }
    return formatUsdMessage(price);
  } catch {
    return "❌ خطا در دریافت قیمت از provider.";
  }
}

/** قیمت کاربر — گزارش کامل بازار (مسیر جدا از دستور ادمین) */
async function buildUserPriceText(env: Env, deps: JobDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const marketHours = deps.marketHours ?? DEFAULT_MARKET_HOURS;
  const market = evaluateMarketSession(
    now(),
    marketHours.defaultSession,
    marketHours,
  );
  if (market.state === "UNKNOWN") {
    // fail-closed — سازگار با سیاست جابها
    return "❓ وضعیت ساعت بازار نامشخص است — برای امنیت قیمت نمایش داده نمی‌شود.";
  }
  try {
    const provider = deps.provider ?? getProvider(env);
    const report = await provider.fetchMarketReport();
    if (!report) {
      return `⚠️ فعلاً داده‌ای از provider دریافت نشد (provider: ${env.PRICE_PROVIDER}). هیچ مقدار جایگزین نمایش داده نمی‌شود.`;
    }
    const items = sanitizeReportItems(report.items);
    const text = formatMarketReport({ ...report, items });
    if (text === null) {
      return "⚠️ داده دریافت شد اما آیتم معتبری برای نمایش نداشت.";
    }
    return text;
  } catch {
    return "❌ خطا در دریافت قیمت از provider.";
  }
}

/** گزارش ذخیرهشده کاربر — بدون fetch جدید؛ زمان داده صادقانه نمایش داده میشود */
async function buildUserCachedReportText(env: Env): Promise<string> {
  const cached = await readLastReport(env.STATE);
  if (!cached) {
    return "هنوز گزارشی ذخیره نشده است. گزارش تازه: /price";
  }
  const items = sanitizeReportItems(cached.items);
  const text = formatMarketReport({ ...cached, items });
  if (text === null) {
    return "گزارش ذخیره‌شده آیتم معتبری ندارد.";
  }
  return text;
}

/** وضعیت ساده کاربر — بدون جزئیات مدیریتی */
async function buildUserStatusText(env: Env): Promise<string> {
  const paused = await isPaused(env.STATE);
  const lastReport = await readLastReport(env.STATE);
  const lines = [
    "📊 وضعیت ربات",
    `وضعیت انتشار کانال: ${paused ? "⏸ متوقف" : "✅ فعال"}`,
    `آخرین گزارش بازار: ${
      lastReport ? faTimestamp(lastReport.fetchedAt) : "—"
    }`,
    `منبع قیمت: ${env.PRICE_PROVIDER === "stub" ? "آزمایشی (بدون داده واقعی)" : env.PRICE_PROVIDER}`,
  ];
  return lines.join("\n");
}
