import { timingSafeEqual } from "./constant-time";

/**
 * اعتبارسنجی ورودی Telegram:
 *  1) webhook secret — هدر استاندارد setWebhook با secret_token
 *  2) authorization ادمین — بر اساس from.id (نه chat_id!)
 *
 * ساختار مشکوک/ناقص update همیشه رد می‌شود (fail-closed).
 */

export interface TelegramMessageInfo {
  text: string;
  chatId: number;
  fromId: number;
}

/** callback_query اعتبارسنجی‌شده — شناسه کاربر فقط سمت سرور */
export interface TelegramCallbackInfo {
  /** id برای answerCallbackQuery */
  id: string;
  /** شناسه فرستنده — فقط از خود update (هرگز از data) */
  fromId: number;
  /** چتی که پیام دکمه در آن است — مقصد پاسخ */
  chatId: number;
  /** نوع اقدام — فقط از whitelist محدود (بدون شناسه جاسازی‌شده) */
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** استخراج امن message از update */
export function extractUpdateMessage(
  update: unknown,
): TelegramMessageInfo | null {
  if (!isRecord(update)) return null;
  const message = update.message ?? update.edited_message;
  if (!isRecord(message)) return null;
  const { text, chat, from } = message as Record<string, unknown>;
  if (typeof text !== "string" || text.length === 0 || text.length > 512)
    return null;
  if (!isRecord(chat) || !isRecord(from)) return null;
  const chatId = (chat as Record<string, unknown>).id;
  const fromId = (from as Record<string, unknown>).id;
  if (typeof chatId !== "number" || typeof fromId !== "number") return null;
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(fromId))
    return null;
  return { text: text.trim(), chatId, fromId };
}

/** حداکثر طول data در callback (حد تلگرام ۶۴ بایت است) */
const MAX_CALLBACK_DATA_LENGTH = 64;

/**
 * استخراج امن callback_query از update.
 * ساختار ناقص/مشکوک → null (fail-closed).
 * شناسه کاربر فقط از callback_query.from.id — هرگز از data.
 */
export function extractCallbackQuery(
  update: unknown,
): TelegramCallbackInfo | null {
  if (!isRecord(update)) return null;
  const callbackQuery = update.callback_query;
  if (!isRecord(callbackQuery)) return null;

  const { id, from, message, data } = callbackQuery as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
  if (!isRecord(from)) return null;
  const fromId = (from as Record<string, unknown>).id;
  if (typeof fromId !== "number" || !Number.isSafeInteger(fromId))
    return null;

  // پیام حاوی دکمه — چت آن مقصد پاسخ است
  if (!isRecord(message)) return null;
  const chat = (message as Record<string, unknown>).chat;
  if (!isRecord(chat)) return null;
  const chatId = (chat as Record<string, unknown>).id;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId))
    return null;

  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > MAX_CALLBACK_DATA_LENGTH
  )
    return null;

  return { id, fromId, chatId, data };
}

/** فقط فرستندهای با user id دقیقاً برابر ADMIN_USER_ID ادمین است */
export function isAuthorizedAdmin(
  fromId: number,
  adminUserId: number,
): boolean {
  return fromId === adminUserId;
}

/** بررسی هدر secret وب‌هوک — مقایسه زمان-ثابت */
export function verifyWebhookSecret(
  provided: string | null,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

/** نام دستور از متن: «/start@mybot» → «start»؛ ورودی غیردستوری → null */
export function parseCommandName(text: string): string | null {
  const match = /^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?\s*$/u.exec(
    text,
  );
  if (!match) return null;
  return (match[1] ?? "").toLowerCase();
}

export interface CommandInput {
  /** نام دستور (حروف کوچک) */
  name: string;
  /** آرگومان بعد از دستور (trimmed) — میتواند خالی باشد */
  rest: string;
}

/**
 * دستور + آرگومان: «/allow 12345» → { name: "allow", rest: "12345" }.
 * برای دستوراتی مثل /allow و /ticket؛ «/cmd@bot arg» هم پشتیبانی میشود.
 * ورودی غیردستوری → null.
 */
export function parseCommandInput(text: string): CommandInput | null {
  const match =
    /^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/u.exec(
      text,
    );
  if (!match) return null;
  const rest = (match[3] ?? "").trim();
  if (rest.length > 512) return null; // سقف همان پیام (۵۱۲)
  return { name: (match[1] ?? "").toLowerCase(), rest };
}
