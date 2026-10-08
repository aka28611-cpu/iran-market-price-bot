/**
 * Allowlist مقصد انتشار پیام.
 *
 * مقصد «انتشار در کانال» فقط و فقط CHANNEL_ID پیکربندی‌شده در env است؛
 * هرگز از chat_id یا ورودی کاربر برای تعیین مقصد استفاده نمی‌شود.
 *
 * (پاسخ دستورات به «چت ادمینِ از قبل احرازشده» می‌رود — ارسال‌کننده
 * با ADMIN_USER_ID تأیید شده است؛ انتشار کانال مسیر جدا و گاردشده دارد.)
 */

export function isAllowedPublishTarget(
  configuredChannelId: string,
  target: string,
): boolean {
  return target === configuredChannelId;
}
