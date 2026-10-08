/**
 * مقایسه زمان-ثابت برای مقادیر حساس (جلوگیری از timing attack).
 */

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  // تفاوت طول همیشه در XOR نهایی حضور دارد؛ حلقه روی maxLen می‌چرخد
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
