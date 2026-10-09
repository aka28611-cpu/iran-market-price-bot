import type { Env, KVLike } from "../env";
import { logWarn } from "../logging";
import { TelegramClient } from "../telegram/client";
import { ALLOW_LIST_MAX, readAllowedUsers, writeAllowedUsers } from "../state";

/**
 * سیاست دسترسی — منبع یگانه تصمیم‌های دسترسی.
 *
 * دو گات مستقل و سمت سرور:
 *  1) عضویت در کانال (getChatMember) — سه‌حالته
 *  2) مجوز استفاده (allowlist در KV) — جدا از عضویت
 *
 * اصول:
 *  • خطای API هرگز «عدم عضویت» تفسیر نمی‌شود → "unknown" → مسدود (fail-closed)
 *  • عضویت به‌تنهایی مجوز نیست؛ مجوز فقط از allowlist
 *  • ادمین (ADMIN_USER_ID) همیشه دسترسی مدیریتی دارد (در commands.ts)
 */

/** نتیجه بررسی عضویت — سه‌حالته */
export type MembershipStatus = "member" | "not-member" | "unknown";

/** وضعیت‌های تلگرام که «عضو» محسوب می‌شوند */
const MEMBER_STATUSES: readonly string[] = [
  "creator",
  "administrator",
  "member",
  "restricted", // عضو با محدودیت (گروه‌ها) — عضویت برقرار است
];

/** وضعیت‌های تلگرام که «غیرعضو» قطعی است */
const NOT_MEMBER_STATUSES: readonly string[] = ["left", "kicked"];

/** نگاشت وضعیت خام تلگرام به نتیجه سه‌حالته — ناشناس = unknown */
export function mapMemberStatus(raw: string | undefined): MembershipStatus {
  if (raw === undefined) return "unknown";
  if (MEMBER_STATUSES.includes(raw)) return "member";
  if (NOT_MEMBER_STATUSES.includes(raw)) return "not-member";
  return "unknown"; // وضعیت آینده/ناشناس تلگرام → fail-closed
}

export interface AccessDeps {
  /** تزریق fetch برای تست */
  fetchFn?: typeof fetch;
}

/**
 * بررسی عضویت کاربر در CHANNEL_ID — فقط سمت سرور.
 * به data ارسالی کلاینت یا کلیک دکمه اعتماد نمی‌شود.
 */
export async function checkChannelMembership(
  userId: number,
  env: Env,
  deps: AccessDeps = {},
): Promise<MembershipStatus> {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });
  const result = await tg.getChatMember(env.CHANNEL_ID, userId);
  if (!result.ok) {
    // خطای API (مثلاً ربات ادمین کانال نیست / شبکه) ≠ عدم عضویت
    logWarn("membership.check-error", { error: result.error ?? "UNKNOWN" });
    return "unknown";
  }
  return mapMemberStatus(result.memberStatus);
}

// ---------- Allowlist (مجوز استفاده — جدا از عضویت) ----------

/** آیا کاربر در فهرست مجاز است؟ (خواندن خراب → false — fail-closed) */
export async function isUserAllowed(
  kv: KVLike,
  userId: number,
): Promise<boolean> {
  const users = await readAllowedUsers(kv);
  return users.includes(userId);
}

export interface AllowlistResult {
  ok: boolean;
  reason?: string;
}

/** افزودن کاربر به فهرست مجاز (توسط ادمین) */
export async function allowUser(
  kv: KVLike,
  userId: number,
  adminId: number,
): Promise<AllowlistResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    return { ok: false, reason: "INVALID_USER_ID" };
  if (userId === adminId)
    return { ok: false, reason: "IS_ADMIN_ALREADY" };
  const users = await readAllowedUsers(kv);
  if (users.includes(userId)) return { ok: false, reason: "ALREADY_ALLOWED" };
  if (users.length >= ALLOW_LIST_MAX)
    return { ok: false, reason: "LIMIT_REACHED" };
  await writeAllowedUsers(kv, [...users, userId]);
  return { ok: true };
}

/** حذف کاربر از فهرست مجاز (توسط ادمین) */
export async function revokeUser(
  kv: KVLike,
  userId: number,
  adminId: number,
): Promise<AllowlistResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    return { ok: false, reason: "INVALID_USER_ID" };
  if (userId === adminId)
    return { ok: false, reason: "IS_ADMIN" };
  const users = await readAllowedUsers(kv);
  if (!users.includes(userId)) return { ok: false, reason: "NOT_ALLOWED" };
  await writeAllowedUsers(
    kv,
    users.filter((id) => id !== userId),
  );
  return { ok: true };
}

/** فهرست کاربران مجاز (برای /users ادمین) */
export async function listAllowedUsers(kv: KVLike): Promise<number[]> {
  return readAllowedUsers(kv);
}
