/**
 * لاگ امن — JSON خطی با redaction خودکار.
 *
 * قواعد:
 *  • کلیدهای حساس (token/secret/key/…) همیشه [REDACTED] می‌شوند.
 *  • مقادیر رشته‌ای که شبیه توکن باشند پوشانده می‌شوند.
 *  • مقادیر طولانی truncate می‌شوند.
 */

const SENSITIVE_KEY_RE =
  /token|secret|password|passphrase|authorization|credential|api[-_]?key/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /\b\d{5,}:[A-Za-z0-9_-]{25,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
  /glpat-[A-Za-z0-9_-]{15,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

const REDACTED = "[REDACTED]";
const MAX_VALUE_LENGTH = 200;

function redactString(value: string): string {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return REDACTED;
  }
  return value.length > MAX_VALUE_LENGTH
    ? value.slice(0, MAX_VALUE_LENGTH) + "…"
    : value;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactValue(inner);
    }
    return out;
  }
  return value;
}

function emit(
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = {
    level,
    event,
    time: new Date().toISOString(),
  };
  if (data) {
    Object.assign(line, redactValue(data) as Record<string, unknown>);
  }
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function logInfo(event: string, data?: Record<string, unknown>): void {
  emit("info", event, data);
}

export function logWarn(event: string, data?: Record<string, unknown>): void {
  emit("warn", event, data);
}

export function logError(event: string, data?: Record<string, unknown>): void {
  emit("error", event, data);
}
