import type { Env } from "../env";
import { isAuthorizedAdmin, type TelegramMessageInfo } from "../auth/telegram-auth";
import { logInfo, logWarn } from "../logging";
import { rateLimit } from "../ratelimit";
import {
  addTicketReply,
  createTicket,
  getOpenTicket,
  type Ticket,
} from "../support/tickets";
import { TelegramClient } from "./client";
import type { MenuView } from "./menu";
import {
  adminTicketDetailView,
  fallbackHintView,
  mainMenuView,
  operationInvalidView,
  replyPromptView,
  ticketConfirmPromptView,
  ticketCreatedView,
  ticketDetailView,
  ticketSubjectPromptView,
  ticketTextPromptView,
  truncate,
} from "./menu";
import {
  clearConversation,
  readConversation,
  writeConversation,
  type ConversationState,
} from "./conversation";

/**
 * جریان‌های تعاملی مبتنی بر متن (ثبت تیکت، پاسخ کاربر/ادمین).
 *
 * امنیت:
 *  • مالکیت و نقش همیشه سمت سرور: user_reply فقط صاحب تیکت،
 *    admin_reply فقط ADMIN_USER_ID (در هر مرحله دوباره بررسی میشود)
 *  • متن کاربر فقط از update.message — هرگز از callback data
 *  • پیام ویرایش‌شده (edited_message) نادیده گرفته میشود تا پاسخ تکراری ثبت نشود
 */

/** سقف پیامهای متنی جریان per user در دقیقه */
const FLOW_TEXT_RATE_LIMIT = 20;

export interface RenderTarget {
  chatId: number;
  messageId?: number;
}

/** رندر view در همان پیام (edit) — در صورت خطا ارسال پیام جدید */
export async function renderView(
  tg: TelegramClient,
  target: RenderTarget,
  view: MenuView,
): Promise<{ messageId?: number }> {
  if (target.messageId !== undefined) {
    const edited = await tg.editMessageText(
      target.chatId,
      target.messageId,
      view.text,
      { replyMarkup: { inline_keyboard: view.keyboard } },
    );
    if (edited.ok) return { messageId: target.messageId };
    // پیام قابل ویرایش نیست (حذف شده / قدیمی) → پیام جدید
  }
  const sent = await tg.sendMessage(target.chatId, view.text, {
    replyMarkup: { inline_keyboard: view.keyboard },
  });
  return { messageId: sent.ok ? sent.messageId : undefined };
}

/** prompt فعلی مکالمه را با هشدارِ ورودی نامعتبر دوباره رندر میکند */
async function renderPromptWithWarning(
  tg: TelegramClient,
  state: ConversationState,
  warning: string,
): Promise<void> {
  const base: MenuView = promptViewFor(state);
  await renderView(tg, { chatId: state.promptChatId, messageId: state.promptMessageId }, {
    text: `${base.text}\n\n⚠️ ${warning}`,
    keyboard: base.keyboard,
  });
}

function promptViewFor(state: ConversationState): MenuView {
  switch (state.flow) {
    case "ticket_create":
      switch (state.step) {
        case "subject":
          return ticketSubjectPromptView();
        case "text":
          return ticketTextPromptView(state.draft.subject);
        case "confirm":
          return ticketConfirmPromptView(state.draft.subject, state.draft.text);
      }
      break;
    case "user_reply":
      return replyPromptView(state.ticketId, false);
    case "admin_reply":
      return replyPromptView(state.ticketId, true);
  }
  return fallbackHintView();
}

// ---------- شروع جریانها (از callback) ----------

/** شروع ثبت تیکت (مسیر فرار پشتیبانی — بدون گات عضویت/مجوز) */
export async function startTicketCreateFlow(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  userId: number,
  now = () => new Date(),
): Promise<void> {
  const state: ConversationState = {
    flow: "ticket_create",
    step: "subject",
    draft: { subject: "", text: "" },
    promptMessageId: target.messageId ?? 0,
    promptChatId: target.chatId,
    updatedAt: now().toISOString(),
  };
  const rendered = await renderView(tg, target, ticketSubjectPromptView());
  state.promptMessageId = rendered.messageId ?? target.messageId ?? 0;
  await writeConversation(env.STATE, userId, state);
}

/** شروع پاسخ کاربر به تیکت خودش — مالکیت سمت سرور */
export async function startUserReplyFlow(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  userId: number,
  ticketId: number,
  now = () => new Date(),
): Promise<void> {
  const ticket = await getOpenTicket(env.STATE, ticketId);
  if (!ticket || ticket.userId !== userId) {
    await renderView(tg, target, operationInvalidView("این تیکت در دسترس شما نیست."));
    return;
  }
  const state: ConversationState = {
    flow: "user_reply",
    step: "text",
    ticketId,
    promptMessageId: target.messageId ?? 0,
    promptChatId: target.chatId,
    updatedAt: now().toISOString(),
  };
  const rendered = await renderView(tg, target, replyPromptView(ticketId, false));
  state.promptMessageId = rendered.messageId ?? target.messageId ?? 0;
  await writeConversation(env.STATE, userId, state);
}

/** شروع پاسخ ادمین — مجوز سمت سرور (فقط ADMIN_USER_ID) */
export async function startAdminReplyFlow(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  adminId: number,
  ticketId: number,
  now = () => new Date(),
): Promise<void> {
  if (!isAuthorizedAdmin(adminId, env.ADMIN_USER_ID)) {
    logWarn("flow.admin-reply.forbidden", { adminId });
    return;
  }
  const ticket = await getOpenTicket(env.STATE, ticketId);
  if (!ticket) {
    await renderView(tg, target, operationInvalidView("این تیکت وجود ندارد (شاید بسته شده باشد)."));
    return;
  }
  const state: ConversationState = {
    flow: "admin_reply",
    step: "text",
    ticketId,
    promptMessageId: target.messageId ?? 0,
    promptChatId: target.chatId,
    updatedAt: now().toISOString(),
  };
  const rendered = await renderView(tg, target, replyPromptView(ticketId, true));
  state.promptMessageId = rendered.messageId ?? target.messageId ?? 0;
  await writeConversation(env.STATE, adminId, state);
}

// ---------- متن ورودی در جریان فعال ----------

/**
 * متن پیام کاربر وقتی مکالمهٔ فعالی دارد.
 * خروجی true = توسط جریان مصرف شد؛ false = مکالمه‌ای نبود.
 */
export async function handleConversationText(
  tg: TelegramClient,
  env: Env,
  message: TelegramMessageInfo,
  now = () => new Date(),
): Promise<boolean> {
  if (message.isEdit) return false; // ویرایش پیام قبلی → نادیده (جلوگیری از پاسخ تکراری)
  if (message.chatId !== message.fromId) return false; // فقط چت خصوصی

  const state = await readConversation(env.STATE, message.fromId);
  if (!state) return false;

  if (!rateLimit(`tg:txt:${message.fromId}`, FLOW_TEXT_RATE_LIMIT)) {
    logWarn("flow.text.rate_limited", { userId: message.fromId });
    return true;
  }

  switch (state.flow) {
    case "ticket_create":
      await handleTicketCreateText(tg, env, message, state, now);
      return true;
    case "user_reply":
      await handleUserReplyText(tg, env, message, state, now);
      return true;
    case "admin_reply":
      await handleAdminReplyText(tg, env, message, state, now);
      return true;
  }
}

async function handleTicketCreateText(
  tg: TelegramClient,
  env: Env,
  message: TelegramMessageInfo,
  state: Extract<ConversationState, { flow: "ticket_create" }>,
  now: () => Date,
): Promise<void> {
  const promptTarget = { chatId: state.promptChatId, messageId: state.promptMessageId };
  const text = message.text.trim();

  if (state.step === "subject") {
    const subject = text.split("\n")[0]?.trim() ?? "";
    if (subject.length === 0) {
      await renderPromptWithWarning(tg, state, "موضوع نمیتواند خالی باشد. موضوع را در یک پیام کوتاه بفرستید.");
      return;
    }
    if (subject.length > 80) {
      await renderPromptWithWarning(tg, state, "موضوع طولانی است (حداکثر ۸۰ کاراکتر).");
      return;
    }
    const next: ConversationState = {
      ...state,
      step: "text",
      draft: { subject, text: "" },
      updatedAt: now().toISOString(),
    };
    const rendered = await renderView(tg, promptTarget, ticketTextPromptView(subject));
    next.promptMessageId = rendered.messageId ?? state.promptMessageId;
    await writeConversation(env.STATE, message.fromId, next);
    return;
  }

  if (state.step === "text") {
    if (text.length === 0) {
      await renderPromptWithWarning(tg, state, "متن پیام نمیتواند خالی باشد.");
      return;
    }
    if (text.length > 512) {
      await renderPromptWithWarning(tg, state, "متن طولانی است (حداکثر ۵۱۲ کاراکتر).");
      return;
    }
    const next: ConversationState = {
      ...state,
      step: "confirm",
      draft: { subject: state.draft.subject, text },
      updatedAt: now().toISOString(),
    };
    const rendered = await renderView(
      tg,
      promptTarget,
      ticketConfirmPromptView(state.draft.subject, text),
    );
    next.promptMessageId = rendered.messageId ?? state.promptMessageId;
    await writeConversation(env.STATE, message.fromId, next);
    return;
  }

  // step === "confirm" — تأیید فقط با دکمه انجام میشود
  await renderPromptWithWarning(tg, state, "برای تأیید یا لغو، از دکمههای زیر پیام استفاده کنید.");
}

async function handleUserReplyText(
  tg: TelegramClient,
  env: Env,
  message: TelegramMessageInfo,
  state: Extract<ConversationState, { flow: "user_reply" }>,
  now: () => Date,
): Promise<void> {
  const text = message.text.trim();
  if (text.length === 0) {
    await renderPromptWithWarning(tg, state, "متن پاسخ نمیتواند خالی باشد.");
    return;
  }
  if (text.length > 512) {
    await renderPromptWithWarning(tg, state, "پاسخ طولانی است (حداکثر ۵۱۲ کاراکتر).");
    return;
  }

  // نقش و مالکیت سمت سرور — از data هیچ چیزی نمیآید
  const result = await addTicketReply(
    env.STATE,
    state.ticketId,
    message.fromId,
    "user",
    text,
    env.ADMIN_USER_ID,
    now,
  );
  const promptTarget = { chatId: state.promptChatId, messageId: state.promptMessageId };
  await clearConversation(env.STATE, message.fromId);

  if (!result.ok || !result.ticket) {
    const reason =
      result.reason === "FORBIDDEN"
        ? "این تیکت متعلق به شما نیست."
        : result.reason === "REPLY_LIMIT_REACHED"
          ? "گفتگوی این تیکت به سقف رسیده است."
          : "این تیکت بسته یا حذف شده است.";
    await renderView(tg, promptTarget, operationInvalidView(reason));
    return;
  }

  await renderView(tg, promptTarget, ticketDetailView(result.ticket));
  await notifyAdminUserReply(tg, env, result.ticket);
}

async function handleAdminReplyText(
  tg: TelegramClient,
  env: Env,
  message: TelegramMessageInfo,
  state: Extract<ConversationState, { flow: "admin_reply" }>,
  now: () => Date,
): Promise<void> {
  // مجوز ادمین در هر مرحله دوباره بررسی میشود
  if (!isAuthorizedAdmin(message.fromId, env.ADMIN_USER_ID)) {
    await clearConversation(env.STATE, message.fromId);
    logWarn("flow.admin-reply.text-forbidden", { userId: message.fromId });
    return;
  }
  const text = message.text.trim();
  if (text.length === 0 || text.length > 512) {
    await renderPromptWithWarning(
      tg,
      state,
      text.length === 0 ? "متن پاسخ نمیتواند خالی باشد." : "پاسخ طولانی است (حداکثر ۵۱۲ کاراکتر).",
    );
    return;
  }

  const result = await addTicketReply(
    env.STATE,
    state.ticketId,
    message.fromId,
    "support",
    text,
    env.ADMIN_USER_ID,
    now,
  );
  const promptTarget = { chatId: state.promptChatId, messageId: state.promptMessageId };
  await clearConversation(env.STATE, message.fromId);

  if (!result.ok || !result.ticket) {
    await renderView(
      tg,
      promptTarget,
      operationInvalidView("این تیکت بسته یا حذف شده است."),
    );
    return;
  }

  await renderView(tg, promptTarget, adminTicketDetailView(result.ticket));
  await deliverSupportReplyToUser(tg, env, result.ticket);
}

// ---------- تأیید / شروع مجدد / لغو (callback) ----------

/** تأیید نهایی ثبت تیکت — درفت فقط از KV، نه از callback */
export async function confirmTicketCreate(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  userId: number,
  now = () => new Date(),
): Promise<void> {
  const state = await readConversation(env.STATE, userId);
  if (!state || state.flow !== "ticket_create" || state.step !== "confirm") {
    await renderView(tg, target, operationInvalidView("جریان ثبت تیکت فعال نیست. از «📝 ثبت تیکت» شروع کنید."));
    return;
  }

  const result = await createTicket(
    env.STATE,
    userId,
    state.draft.subject,
    state.draft.text,
    now,
  );
  await clearConversation(env.STATE, userId);

  if (!result.ok || !result.ticket) {
    const reason =
      result.reason === "USER_LIMIT_REACHED"
        ? "شما ۳ تیکت باز دارید؛ ابتدا منتظر پاسخ یا بسته‌شدن آنها بمانید."
        : result.reason === "TOTAL_LIMIT_REACHED"
          ? "ظرفیت صف تیکتها پر است؛ لطفاً بعداً تلاش کنید."
          : "ثبت تیکت ناموفق بود. دوباره تلاش کنید.";
    await renderView(tg, target, operationInvalidView(reason));
    return;
  }

  await renderView(tg, target, ticketCreatedView(result.ticket.id));
  await notifyAdminNewTicket(tg, env, result.ticket);
}

/** شروع مجدد ثبت تیکت (از مرحله ۱) */
export async function restartTicketCreate(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  userId: number,
  now = () => new Date(),
): Promise<void> {
  const state = await readConversation(env.STATE, userId);
  if (!state || state.flow !== "ticket_create") {
    await renderView(tg, target, operationInvalidView("جریان ثبت تیکت فعال نیست."));
    return;
  }
  await startTicketCreateFlow(tg, env, target, userId, now);
}

/** لغو جریان فعال — بازگشت به منوی اصلی (یا پنل ادمین برای ادمین) */
export async function cancelConversation(
  tg: TelegramClient,
  env: Env,
  target: RenderTarget,
  userId: number,
): Promise<void> {
  const had = await readConversation(env.STATE, userId);
  if (had) await clearConversation(env.STATE, userId);
  const isAdmin = isAuthorizedAdmin(userId, env.ADMIN_USER_ID);
  await renderView(tg, target, mainMenuView(isAdmin));
}

// ---------- اطلاع‌رسانی‌ها ----------

/** اطلاع ادمین از تیکت جدید (با دکمههای مدیریتی) */
export async function notifyAdminNewTicket(
  tg: TelegramClient,
  env: Env,
  ticket: Ticket,
): Promise<void> {
  const view = adminTicketDetailView(ticket);
  await tg.sendMessage(env.ADMIN_USER_ID, `🔔 تیکت جدید:\n\n${view.text}`, {
    replyMarkup: { inline_keyboard: view.keyboard },
  });
  logInfo("flow.ticket.created", { ticketId: ticket.id, userId: ticket.userId });
}

/** اطلاع ادمین از پاسخ کاربر */
export async function notifyAdminUserReply(
  tg: TelegramClient,
  env: Env,
  ticket: Ticket,
): Promise<void> {
  const view = adminTicketDetailView(ticket);
  const last = ticket.replies[ticket.replies.length - 1];
  await tg.sendMessage(
    env.ADMIN_USER_ID,
    `🔔 پاسخ جدید کاربر روی تیکت #${ticket.id}:\n${truncate(last?.text ?? "", 200)}\n\n${view.text}`,
    { replyMarkup: { inline_keyboard: view.keyboard } },
  );
}

/** تحویل پاسخ پشتیبانی به چت کاربر (با دکمههای پیگیری) */
export async function deliverSupportReplyToUser(
  tg: TelegramClient,
  env: Env,
  ticket: Ticket,
): Promise<void> {
  const view = ticketDetailView(ticket);
  await tg.sendMessage(ticket.userId, `🛡 پاسخ جدید پشتیبانی:\n\n${view.text}`, {
    replyMarkup: { inline_keyboard: view.keyboard },
  });
}
