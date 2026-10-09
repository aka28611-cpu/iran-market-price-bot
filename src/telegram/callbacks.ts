/**
 * پروتکل callback دکمه‌ها — کدکد فشرده و اعتبارسنجی سخت‌گیرانه.
 *
 * اصول امنیتی:
 *  • callback_data فقط «نوع عملیات + شناسه عددی اختیاری» است — هیچ نقش،
 *    مجوز یا داده قابل‌جعل در آن جاسازی نمی‌شود.
 *  • مالکیت/ادمین/وضعیت تیکت همیشه سمت سرور از KV و from.id بررسی می‌شود؛
 *    مخفی‌کردن دکمه هرگز «کنترل دسترسی» نیست.
 *  • سقف طول ۶۴ بایت تلگرام رعایت می‌شود (id ≤ 9 رقم).
 *  • data ناشناس/خراب → null (fail-closed، بدون پاسخ اضافه).
 */

export type CallbackAction =
  // منوها
  | { kind: "home" }
  | { kind: "prices" }
  | { kind: "status" }
  | { kind: "tickets" }
  | { kind: "ticket_new" }
  | { kind: "ticket_confirm" }
  | { kind: "ticket_restart" }
  | { kind: "cancel" }
  | { kind: "recheck" }
  // تیکت کاربر (ملکیت سمت سرور بررسی می‌شود)
  | { kind: "ticket_view"; id: number }
  | { kind: "ticket_reply"; id: number }
  | { kind: "ticket_close_confirm"; id: number }
  | { kind: "ticket_close_yes"; id: number }
  // ادمین (مجوز ادمین سمت سرور بررسی می‌شود)
  | { kind: "admin_home" }
  | { kind: "admin_tickets" }
  | { kind: "admin_view"; id: number }
  | { kind: "admin_reply"; id: number }
  | { kind: "admin_close_confirm"; id: number }
  | { kind: "admin_close_yes"; id: number }
  | { kind: "admin_refresh" };

/** ساخت callback_data از عملیات — طول همیشه ≤ 64 بایت */
export function encodeCallback(action: CallbackAction): string {
  switch (action.kind) {
    case "home":
      return "home";
    case "prices":
      return "px";
    case "status":
      return "st";
    case "tickets":
      return "tks";
    case "ticket_new":
      return "tkn";
    case "ticket_confirm":
      return "tkcf";
    case "ticket_restart":
      return "tkrs";
    case "cancel":
      return "cxl";
    case "recheck":
      return "rc";
    case "ticket_view":
      return `tkv${action.id}`;
    case "ticket_reply":
      return `tkr${action.id}`;
    case "ticket_close_confirm":
      return `tkc${action.id}`;
    case "ticket_close_yes":
      return `tky${action.id}`;
    case "admin_home":
      return "ad";
    case "admin_tickets":
      return "adt";
    case "admin_view":
      return `adv${action.id}`;
    case "admin_reply":
      return `adr${action.id}`;
    case "admin_close_confirm":
      return `adc${action.id}`;
    case "admin_close_yes":
      return `ady${action.id}`;
    case "admin_refresh":
      return "adrh";
  }
}

/** id عددی مجاز: رقمهای اسکی، حداکثر ۹ رقم (سقف شمارنده تیکت) */
const ID_RE = /^\d{1,9}$/;

/** تجزیهٔ callback_data — هر رشتهٔ خارج از پروتکل → null (fail-closed) */
export function decodeCallback(data: string): CallbackAction | null {
  if (typeof data !== "string" || data.length === 0 || data.length > 64)
    return null;
  switch (data) {
    case "home":
      return { kind: "home" };
    case "px":
      return { kind: "prices" };
    case "st":
      return { kind: "status" };
    case "tks":
      return { kind: "tickets" };
    case "tkn":
      return { kind: "ticket_new" };
    case "tkcf":
      return { kind: "ticket_confirm" };
    case "tkrs":
      return { kind: "ticket_restart" };
    case "cxl":
      return { kind: "cancel" };
    case "rc":
      return { kind: "recheck" };
    case "ad":
      return { kind: "admin_home" };
    case "adt":
      return { kind: "admin_tickets" };
    case "adrh":
      return { kind: "admin_refresh" };
    default:
      break;
  }
  // الگوهای «پیشوند + id عددی» — با انکرای دقیق (بدون قبول پسوند اضافه)
  const withId = (prefix: string): number | null => {
    if (!data.startsWith(prefix)) return null;
    const idPart = data.slice(prefix.length);
    if (!ID_RE.test(idPart)) return null;
    const value = Number(idPart);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const id = withId("tkv");
  if (id !== null) return { kind: "ticket_view", id };
  const replyId = withId("tkr");
  if (replyId !== null) return { kind: "ticket_reply", id: replyId };
  const cc = withId("tkc");
  if (cc !== null) return { kind: "ticket_close_confirm", id: cc };
  const cy = withId("tky");
  if (cy !== null) return { kind: "ticket_close_yes", id: cy };
  const av = withId("adv");
  if (av !== null) return { kind: "admin_view", id: av };
  const ar = withId("adr");
  if (ar !== null) return { kind: "admin_reply", id: ar };
  const adc = withId("adc");
  if (adc !== null) return { kind: "admin_close_confirm", id: adc };
  const ady = withId("ady");
  if (ady !== null) return { kind: "admin_close_yes", id: ady };
  return null;
}

/** آیا عملیات نیاز به گیت‌های کاربر (عضویت + مجوز) دارد؟ */
export function requiresUserGates(action: CallbackAction): boolean {
  switch (action.kind) {
    case "home":
    case "prices":
    case "status":
    case "tickets":
      return true;
    default:
      // پشتیبانی (تیکت)، ادمین و recheck مسیر مستقل دارند
      return false;
  }
}
