import type { KVLike } from "../env";
import { CONVERSATION_PREFIX, readJson, writeJson } from "../state";

/**
 * وضعیت مکالمهٔ جریان‌های ورودی متنی (KV-backed، per-user).
 *
 * کاربرد: مراحل «موضوع → متن → تأیید» ثبت تیکت و «پاسخ» کاربر/ادمین.
 *
 * طراحی:
 *  • کلید conv:<userId> — تنها یک جریان فعال per user
 *  • TTL دو لایه: expirationTtl در KV (۶۰۱ ثانیه) + چک زمانی در خواندن
 *    (mockهای تست TTL را نادیده می‌گیرند → چک زمانی پاسخ میدهد)
 *  • promptMessageId: پیام راهنمای ربات که در هر مرحله با editMessageText
 *    به‌روز می‌شود — چت پر از پیام تکراری نمی‌شود
 *  • داده قابل‌جعل نیست: همهٔ فیلدها در KV سمت سرور نوشته می‌شوند؛
 *    متن کاربر فقط از update.message می‌آید
 */

/** عمر مفید مکالمه — ثانیه (KV حداقل ۶۰) */
export const CONVERSATION_TTL_SECONDS = 600;

export type ConversationState =
  | {
      flow: "ticket_create";
      step: "subject" | "text" | "confirm";
      draft: { subject: string; text: string };
      promptMessageId: number;
      promptChatId: number;
      updatedAt: string;
    }
  | {
      flow: "user_reply";
      step: "text";
      ticketId: number;
      promptMessageId: number;
      promptChatId: number;
      updatedAt: string;
    }
  | {
      flow: "admin_reply";
      step: "text";
      ticketId: number;
      promptMessageId: number;
      promptChatId: number;
      updatedAt: string;
    };

/** مکالمه منقضی؟ (چک زمانی مستقل از KV TTL — برای mockهای تست) */
export function isConversationExpired(
  state: ConversationState,
  now = () => new Date(),
): boolean {
  const ts = Date.parse(state.updatedAt);
  if (Number.isNaN(ts)) return true;
  return now().getTime() - ts > CONVERSATION_TTL_SECONDS * 1000;
}

export async function readConversation(
  kv: KVLike,
  userId: number,
): Promise<ConversationState | null> {
  const state = await readJson<ConversationState>(
    kv,
    `${CONVERSATION_PREFIX}${userId}`,
  );
  if (!state || typeof state.flow !== "string") return null;
  if (isConversationExpired(state)) {
    await clearConversation(kv, userId);
    return null;
  }
  return state;
}

export async function writeConversation(
  kv: KVLike,
  userId: number,
  state: ConversationState,
): Promise<void> {
  await writeJson(kv, `${CONVERSATION_PREFIX}${userId}`, state, {
    expirationTtl: CONVERSATION_TTL_SECONDS + 1,
  });
}

export async function clearConversation(kv: KVLike, userId: number): Promise<void> {
  try {
    await kv.delete(`${CONVERSATION_PREFIX}${userId}`);
  } catch {
    // حذف کلید مکالمه حیاتی نیست — TTL خودش پاک می‌کند
  }
}
