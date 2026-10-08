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
