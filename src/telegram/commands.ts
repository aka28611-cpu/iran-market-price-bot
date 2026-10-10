import type { Env } from "../env";
import {
  checkChannelMembership,
  isUserAllowed,
  listAllowedUsers,
  allowUser,
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
import { faTimestamp } from "../datetime";
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
  getOpenTicket,
} from "../support/tickets";
import { sanitizeReportItems, validateUsdPrice } from "../validation";
import { decodeCallback, type CallbackAction } from "./callbacks";
import { TelegramClient } from "./client";
import { formatMarketReport, formatUsdMessage } from "./format";
import {
  cancelConversation,
  confirmTicketCreate,
  handleConversationText,
  notifyAdminNewTicket,
  renderView,
  restartTicketCreate,
  startAdminReplyFlow,
  startTicketCreateFlow,
  startUserReplyFlow,
  type RenderTarget,
} from "./flows";
import {
  adminMenuView,
  adminTicketDetailView,
  adminTicketListView,
  fallbackHintView,
  joinPromptView,
  mainMenuView,
  membershipUnknownView,
  operationInvalidView,
  pricesView,
  restrictedView,
  statusView,
  ticketClosedView,
  ticketCreatedView,
  closeConfirmView,
  ticketDetailView,
  ticketListView,
} from "./menu";
import {
  runUsdRefresh,
  describeJobResult,
  type JobDeps,
} from "../scheduler/usd-job";
import { clearConversation } from "./conversation";

/**
 * پردازش updateهای Telegram — معماری بازطراحی‌شده (round 15).
 *
 * جریانها:
 *  1) callback_query → منوها/جریانهای دکمهای (edit در همان پیام)
 *  2) متن غیردستوری → مصرف توسط مکالمهٔ فعال (تیکت/پاسخ) یا راهنمای منو
 *  3) دستورها: ادمین (مدیریتی) / پشتیبانی (مسیر فرار همه) / محافظت‌شده کاربر
 *
 * امنیت:
 *  • هر دو گات (عضویت + مجوز) روی هر callback/دستور محافظت‌شده سمت سرور
 *  • مالکیت تیکت و سطح ادمین در هر عملیات دوباره بررسی میشود —
 *    مخفی‌کردن دکمه کنترل دسترسی نیست
 *  • شناسه کاربر فقط از from.id خود update — هرگز از data
 *  • همهٔ تعاملات کاربر فقط در چت خصوصی (chat.id === from.id)
 *  • پاسخ همیشه با answerCallbackQuery (توقف نشانگر بارگذاری)
 */

/** سقف دستورات هر کاربر در دقیقه */
const COMMAND_RATE_LIMIT = 20;
/** سقف callback هر کاربر در دقیقه */
const CALLBACK_RATE_LIMIT = 20;

const TEST_TEXT = "✅ پیام آزمایشی ربات قیمت بازار — اتصال کانال برقرار است.";

/** لینک عمومی کانال — از تنظیمات موجود؛ هرگز URL ساختگی */
function resolveChannelLink(env: Env): string {
  if (env.CHANNEL_LINK) return env.CHANNEL_LINK;
  if (env.CHANNEL_ID.startsWith("@")) {
    return `https://t.me/${env.CHANNEL_ID.slice(1)}`;
  }
  return ""; // کانال خصوصی بدون لینک → دکمه حذف میشود
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

    // ۲) متن غیردستوری → مکالمهٔ فعال (جریان تیکت/پاسخ) یا راهنمای کوتاه
    if (!input) {
      if (message.chatId !== message.fromId) return; // گروه → بی‌پاسخ
      const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
        fetchFn: deps.fetchFn,
      });
      const consumed = await handleConversationText(tg, env, message);
      if (consumed) return;
      if (!rateLimit(`tg:txt:${message.fromId}`, COMMAND_RATE_LIMIT)) {
        logWarn("tg.text.rate_limited", { userId: message.fromId });
        return;
      }
      await renderView(tg, { chatId: message.chatId }, fallbackHintView());
      return;
    }

    // دستور = خروج قابل‌پیش‌بینی از هر مکالمهٔ فعال
    await clearActiveConversation(env, message.fromId);

    // ۳) ادمین — دستورات مدیریتی (فقط چت خصوصی)
    if (isAuthorizedAdmin(message.fromId, env.ADMIN_USER_ID)) {
      if (message.chatId !== message.fromId) {
        logInfo("tg.command.admin-non-private", {});
        return;
      }
      await handleAdminCommand(message, input, env, deps);
      return;
    }

    // ۴) مسیر فرار پشتیبانی — برای همه کاربران، بدون گات
    if (input.name === "ticket" || input.name === "mytickets") {
      if (!rateLimit(`tg:cmd:${message.fromId}`, COMMAND_RATE_LIMIT)) {
        logWarn("tg.command.rate_limited", { userId: message.fromId });
        return;
      }
      await handleSupportCommand(message, input, env, deps);
      return;
    }

    // ۵) دستورات محافظت‌شده کاربر — هر دو گات سمت سرور
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
        logInfo("tg.command.unknown", { command: input.name });
        return;
    }
  } catch (err) {
    logError("tg.update.error", {
      message: err instanceof Error ? err.message : "UNKNOWN",
    });
  }
}

async function clearActiveConversation(env: Env, userId: number): Promise<void> {
  await clearConversation(env.STATE, userId);
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

  if (!rateLimit(`tg:cb:${callback.fromId}`, CALLBACK_RATE_LIMIT)) {
    logWarn("tg.callback.rate_limited", { userId: callback.fromId });
    return;
  }

  const action = decodeCallback(callback.data);
  if (!action) {
    // data جعلی/ناشناس — فقط لاگ، بدون پاسخ اضافی
    logWarn("tg.callback.unknown-action", { data: callback.data });
    return;
  }

  const target: RenderTarget = {
    chatId: callback.chatId,
    messageId: callback.messageId,
  };
  const isAdmin = isAuthorizedAdmin(callback.fromId, env.ADMIN_USER_ID);

  // ---- عملیات ادمین: مجوز در هر بار بررسی میشود (سمت سرور) ----
  if (isAdminAction(action)) {
    if (!isAdmin) {
      // کاربر معمولی روی دکمه ادمین (پیام کهنه/جعلی) — بی‌پاسخ
      logWarn("tg.callback.admin-forbidden", { userId: callback.fromId });
      return;
    }
    await handleAdminAction(action, callback, env, deps, target);
    return;
  }

  // ---- عملیات کاربر ----
  switch (action.kind) {
    case "recheck":
    case "home": {
      if (isAdmin) {
        await renderView(tg, target, mainMenuView(true));
        return;
      }
      const allowed = await gateUser(tg, env, callback.fromId, target, deps);
      if (allowed) await renderView(tg, target, mainMenuView(false));
      return;
    }

    case "prices": {
      // ادمین از گات عضویت/مجوز مستثنی است — خطای بررسی عضویت
      // نباید ادمین اصلی را قفل کند (مثل home/recheck)
      if (isAdmin) {
        await renderView(
          tg,
          target,
          pricesView(await buildUserPriceText(env, deps)),
        );
        return;
      }
      const allowed = await gateUser(tg, env, callback.fromId, target, deps);
      if (allowed) {
        await renderView(tg, target, pricesView(await buildUserPriceText(env, deps)));
      }
      return;
    }

    case "status": {
      // ادمین از گات عضویت/مجوز مستثنی است — خطای بررسی عضویت
      // نباید ادمین اصلی را قفل کند (مثل home/recheck)
      if (isAdmin) {
        await renderView(tg, target, statusView(await buildAdminStatusText(env)));
        return;
      }
      const allowed = await gateUser(tg, env, callback.fromId, target, deps);
      if (allowed) {
        await renderView(tg, target, statusView(await buildUserStatusText(env)));
      }
      return;
    }

    // پشتیبانی: مسیر فرار — بدون گات عضویت/مجوز
    case "tickets": {
      const { open, closedCount } = await listUserTickets(
        env.STATE,
        callback.fromId,
      );
      await renderView(tg, target, ticketListView(open, closedCount));
      return;
    }

    case "ticket_new": {
      await startTicketCreateFlow(tg, env, target, callback.fromId);
      return;
    }

    case "ticket_confirm": {
      await confirmTicketCreate(tg, env, target, callback.fromId);
      return;
    }

    case "ticket_restart": {
      await restartTicketCreate(tg, env, target, callback.fromId);
      return;
    }

    case "cancel": {
      await cancelConversation(tg, env, target, callback.fromId);
      return;
    }

    case "ticket_view": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket || ticket.userId !== callback.fromId) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت در دسترس شما نیست (شاید بسته شده باشد)."),
        );
        return;
      }
      await renderView(tg, target, ticketDetailView(ticket));
      return;
    }

    case "ticket_reply": {
      await startUserReplyFlow(tg, env, target, callback.fromId, action.id);
      return;
    }

    case "ticket_close_confirm": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket || ticket.userId !== callback.fromId) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت در دسترس شما نیست."),
        );
        return;
      }
      await renderView(tg, target, closeConfirmView(action.id, false));
      return;
    }

    case "ticket_close_yes": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket || ticket.userId !== callback.fromId) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت در دسترس شما نیست."),
        );
        return;
      }
      const result = await closeTicket(env.STATE, action.id);
      if (!result.ok) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت قبلاً بسته شده است."),
        );
        return;
      }
      await renderView(tg, target, ticketClosedView(action.id));
      await tg.sendMessage(
        env.ADMIN_USER_ID,
        `ℹ️ کاربر ${callback.fromId} تیکت #${action.id} را بست.`,
      );
      return;
    }

    default:
      logWarn("tg.callback.unhandled", { kind: action.kind });
      return;
  }
}

function isAdminAction(action: CallbackAction): boolean {
  return action.kind.startsWith("admin_");
}

async function handleAdminAction(
  action: CallbackAction,
  callback: TelegramCallbackInfo,
  env: Env,
  deps: JobDeps,
  target: RenderTarget,
): Promise<void> {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });
  switch (action.kind) {
    case "admin_home":
      await renderView(tg, target, adminMenuView());
      return;
    case "admin_tickets": {
      const tickets = await listOpenTickets(env.STATE);
      await renderView(tg, target, adminTicketListView(tickets));
      return;
    }
    case "admin_view": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت بسته یا حذف شده است."),
        );
        return;
      }
      await renderView(tg, target, adminTicketDetailView(ticket));
      return;
    }
    case "admin_reply": {
      await startAdminReplyFlow(tg, env, target, callback.fromId, action.id);
      return;
    }
    case "admin_close_confirm": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت بسته یا حذف شده است."),
        );
        return;
      }
      await renderView(tg, target, closeConfirmView(action.id, true));
      return;
    }
    case "admin_close_yes": {
      const ticket = await getOpenTicket(env.STATE, action.id);
      if (!ticket) {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت قبلاً بسته شده است."),
        );
        return;
      }
      const result = await closeTicket(env.STATE, action.id);
      if (result.ok && result.ticket) {
        const notified = await tg.sendMessage(
          result.ticket.userId,
          `✅ تیکت #${action.id} شما بسته شد.\nبرای موضوع جدید از منوی ربات «📝 ثبت تیکت» را بزنید.`,
        );
        await renderView(tg, target, {
          text: notified.ok
            ? `✅ تیکت #${action.id} بسته شد و به کاربر اطلاع داده شد.`
            : `✅ تیکت #${action.id} بسته شد؛ اما اطلاع‌رسانی به کاربر ناموفق بود.`,
          keyboard: adminMenuView().keyboard,
        });
      } else {
        await renderView(
          tg,
          target,
          operationInvalidView("این تیکت قبلاً بسته شده است."),
        );
      }
      return;
    }
    case "admin_refresh": {
      const result = await runUsdRefresh(env, deps);
      await renderView(tg, target, {
        text: `🔄 بروزرسانی کانال:\n${describeJobResult(result)}`,
        keyboard: adminMenuView().keyboard,
      });
      return;
    }
    default:
      logWarn("tg.callback.admin-unhandled", { kind: action.kind });
      return;
  }
}

/**
 * گیت‌های کاربر (عضویت + مجوز) با رندر پیام مسدودکننده در همان target.
 * خروجی true = مجاز (ادامه); false = مسدود (پیام مناسب رندر شد).
 */
async function gateUser(
  tg: TelegramClient,
  env: Env,
  fromId: number,
  target: RenderTarget,
  deps: JobDeps,
): Promise<boolean> {
  const membership = await checkChannelMembership(fromId, env, deps);
  if (membership === "unknown") {
    await renderView(tg, target, membershipUnknownView());
    return false;
  }
  if (membership === "not-member") {
    await renderView(tg, target, joinPromptView(resolveChannelLink(env)));
    logInfo("tg.gate.membership-required", { userId: fromId });
    return false;
  }
  const allowed = await isUserAllowed(env.STATE, fromId);
  if (!allowed) {
    await renderView(
      tg,
      target,
      restrictedView(resolveChannelLink(env), env.SUPPORT_LINK),
    );
    logInfo("tg.gate.denied", { userId: fromId });
    return false;
  }
  return true;
}

// ---------- ادمین (دستورات متنی — سازگار با قبل) ----------

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
  const sendView = async (text: string, keyboard?: unknown): Promise<void> => {
    await tg.sendMessage(message.chatId, text, keyboard ? { replyMarkup: keyboard } : {});
  };

  switch (input.name) {
    case "start": {
      const view = mainMenuView(true);
      await sendView(
        `${view.text}\n\nدستورات متنی مدیریتی (pause، resume، allow، revoke، users، test، update) همچنان فعالاند.`,
        { inline_keyboard: view.keyboard },
      );
      return;
    }

    case "status":
      await sendView(await buildAdminStatusText(env));
      return;

    case "price":
      await sendView(await buildAdminPriceText(env, deps));
      return;

    case "update": {
      const result = await runUsdRefresh(env, deps);
      await sendView(describeJobResult(result));
      return;
    }

    case "pause":
      await setPaused(env.STATE, true);
      await sendView("⏸ انتشار خودکار متوقف شد. برای ادامه /resume بفرستید.");
      return;

    case "resume":
      await setPaused(env.STATE, false);
      await sendView("▶️ انتشار خودکار ادامه یافت.");
      return;

    case "test": {
      const target = env.CHANNEL_ID;
      if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
        await sendView("❌ مقصد مجاز انتشار پیکربندی نشده است.");
        return;
      }
      const sent = await tg.sendMessage(target, TEST_TEXT);
      await sendView(
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
      await sendView(text);
      return;
    }

    case "tickets": {
      const tickets = await listOpenTickets(env.STATE);
      const view = adminTicketListView(tickets);
      await sendView(view.text, { inline_keyboard: view.keyboard });
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
  const notified = await tg.sendMessage(
    result.ticket.userId,
    `✅ تیکت #${ticketId} شما بسته شد.\nبرای موضوع جدید از منوی ربات «📝 ثبت تیکت» را بزنید.`,
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
    // فرم کوتاه: /ticket <متن> → مستقیم ثبت (موضوع از متن مشتق میشود)
    if (input.rest.length === 0) {
      // بدون متن → شروع جریان دکمه‌ای کامل
      await startTicketCreateFlow(tg, env, { chatId: message.chatId }, message.fromId);
      return;
    }
    const subject = `${input.rest.slice(0, 40)}${input.rest.length > 40 ? "…" : ""}`;
    const result = await createTicket(env.STATE, message.fromId, subject, input.rest);
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
    const view = ticketCreatedView(result.ticket.id);
    await tg.sendMessage(message.chatId, view.text, {
      replyMarkup: { inline_keyboard: view.keyboard },
    });
    await notifyAdminNewTicket(tg, env, result.ticket);
    return;
  }

  // /mytickets — فقط تیکتهای خود کاربر (فیلتر سمت سرور)
  const { open, closedCount } = await listUserTickets(
    env.STATE,
    message.fromId,
  );
  const view = ticketListView(open, closedCount);
  await tg.sendMessage(message.chatId, view.text, {
    replyMarkup: { inline_keyboard: view.keyboard },
  });
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
  const target: RenderTarget = { chatId: message.chatId };

  // گات ۱ و ۲ — سمت سرور
  const allowed = await gateUser(tg, env, message.fromId, target, deps);
  if (!allowed) return;

  switch (input.name) {
    case "start": {
      const view = mainMenuView(false);
      await renderView(tg, target, view);
      return;
    }
    case "price": {
      const view = pricesView(await buildUserPriceText(env, deps));
      await renderView(tg, target, view);
      return;
    }
    case "report": {
      const view = pricesView(await buildUserCachedReportText(env));
      await renderView(tg, target, view);
      return;
    }
    case "status": {
      const view = statusView(await buildUserStatusText(env));
      await renderView(tg, target, view);
      return;
    }
    default:
      logInfo("tg.command.unknown", { command: input.name });
      return;
  }
}

// ---------- متنهای وضعیت/قیمت ----------

async function buildAdminStatusText(env: Env): Promise<string> {
  const paused = await isPaused(env.STATE);
  const usdStatus = await readJson<RunStatus>(env.STATE, USD_STATUS_KEY);
  const reportStatus = await readJson<RunStatus>(env.STATE, REPORT_STATUS_KEY);
  const lastPrice = await readLastUsdPrice(env.STATE);

  const lines = [
    "📊 وضعیت ربات",
    `وضعیت: ${paused ? "⏸ متوقف (pause)" : "✅ فعال"}`,
    `Provider: ${env.PRICE_PROVIDER}${
      env.PRICE_PROVIDER === "stub" ? " (بدون API واقعی)" : ""
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
      `آخرین قیمت دلار: خرید ${lastPrice.buy} | فروش ${lastPrice.sell} | معامله ${lastPrice.trade}`,
    );
  }
  if (resolveChannelLink(env) === "") {
    lines.push("⚠️ لینک عمومی کانال پیکربندی نشده — دکمه «عضویت» حذف میشود");
  }
  if (env.SUPPORT_LINK === "") {
    lines.push("ℹ️ SUPPORT_LINK خالی — پشتیبانی از سیستم تیکت داخلی ربات استفاده میکند");
  }
  return lines.join("\n");
}

/** قیمت لحظه‌ای ادمین — مسیر میز خرید/فروش (providerهای فردایی) */
async function buildAdminPriceText(
  env: Env,
  deps: JobDeps,
): Promise<string> {
  try {
    const provider = deps.provider ?? getProvider(env);
    const price = await provider.fetchUsdTehran();
    if (!price) {
      return `⚠️ فعلاً داده‌ای از provider دریافت نشد (provider: ${env.PRICE_PROVIDER}).`;
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

/** قیمت کاربر — گزارش کامل بازار از provider */
async function buildUserPriceText(env: Env, deps: JobDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const marketHours = deps.marketHours ?? DEFAULT_MARKET_HOURS;
  const market = evaluateMarketSession(now(), marketHours.defaultSession, marketHours);
  if (market.state === "UNKNOWN") {
    // fail-closed — سازگار با سیاست جابها
    return "❓ وضعیت ساعت بازار نامشخص است — برای امنیت قیمت نمایش داده نمی‌شود.";
  }
  try {
    const provider = deps.provider ?? getProvider(env);
    const report = await provider.fetchMarketReport();
    if (!report) {
      return "⚠️ الان قیمت‌ها در دسترس نیستند. کمی بعد دوباره تلاش کنید.";
    }
    const items = sanitizeReportItems(report.items);
    const text = formatMarketReport({ ...report, items });
    if (text === null) {
      return "⚠️ داده دریافت شد اما آیتم معتبری برای نمایش نداشت.";
    }
    return text;
  } catch {
    return "❌ خطا در دریافت قیمت. لطفاً کمی بعد دوباره تلاش کنید.";
  }
}

/** گزارش ذخیرهشده کاربر — بدون fetch جدید؛ زمان داده صادقانه نمایش داده میشود */
async function buildUserCachedReportText(env: Env): Promise<string> {
  const cached = await readLastReport(env.STATE);
  if (!cached) {
    return "هنوز گزارشی ذخیره نشده است. برای گزارش تازه، «📊 قیمت‌های بازار» را بزنید.";
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
  const now = new Date();
  const market = evaluateMarketSession(
    now,
    DEFAULT_MARKET_HOURS.defaultSession,
    DEFAULT_MARKET_HOURS,
  );
  const paused = await isPaused(env.STATE);
  const lastReport = await readLastReport(env.STATE);
  const marketLabel =
    market.state === "OPEN" ? "✅ باز است" : market.state === "CLOSED" ? "🌙 بسته است" : "❓ نامشخص";
  const lines = [
    "📊 وضعیت ربات",
    `وضعیت بازار: ${marketLabel}`,
    `وضعیت انتشار کانال: ${paused ? "⏸ متوقف" : "✅ فعال"}`,
    `آخرین گزارش بازار: ${
      lastReport ? faTimestamp(lastReport.fetchedAt) : "—"
    }`,
    `منبع قیمت: ${env.PRICE_PROVIDER === "stub" ? "آزمایشی (بدون داده واقعی)" : env.PRICE_PROVIDER}`,
  ];
  return lines.join("\n");
}
