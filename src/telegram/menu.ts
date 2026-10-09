import { encodeCallback } from "./callbacks";
import { faDigits, faTimestamp } from "../datetime";
import type { Ticket } from "../support/tickets";

/**
 * نمایش منوها و پیامهای تعاملی — فارسی روان و کوتاه، متن خام بدون parse_mode.
 *
 * قواعد:
 *  • بدون Markdown/HTML → هیچ کاراکتر escape یا بک‌اسلشی در متن دیده نمیشود
 *  • ساختار با ایموجی، خط تیره و چیدمان دکمهها (ظواهر رسمی تلگرام —
 *    رنگ/افکت سفارشی دکمه از API پشتیبانی نمیشود و جعل نمیشود)
 *  • هر view = متن + کیبورد؛ رندر (ارسال/ویرایش) با لایه فرمان
 *  • هیچ متن موفقیت ساختگی ساخته نمیشود — ورودیها داده واقعیاند
 */

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface MenuView {
  text: string;
  keyboard: InlineButton[][];
}

const SEP = "────────────────";

const btn = (text: string, action: Parameters<typeof encodeCallback>[0]): InlineButton => ({
  text,
  callback_data: encodeCallback(action),
});

const urlBtn = (text: string, url: string): InlineButton => ({ text, url });

/** ردیفهای پایانی ناوبری */
function backRow(): InlineButton[] {
  return [btn("↩️ بازگشت", { kind: "home" })];
}

function backHomeRows(): InlineButton[][] {
  return [[btn("↩️ بازگشت", { kind: "home" })], [btn("🏠 منوی اصلی", { kind: "home" })]];
}

// ---------- منوی اصلی ----------

export function mainMenuView(isAdmin: boolean): MenuView {
  const rows: InlineButton[][] = [
    [btn("📊 قیمت‌های بازار", { kind: "prices" }), btn("📡 وضعیت ربات", { kind: "status" })],
    [btn("📝 ثبت تیکت", { kind: "ticket_new" }), btn("🎫 تیکت‌های من", { kind: "tickets" })],
  ];
  if (isAdmin) {
    rows.push([btn("👑 پنل مدیریت", { kind: "admin_home" })]);
  }
  return {
    text: "🤖 ربات قیمت بازار ایران\n\nاز دکمه‌های زیر انتخاب کنید:",
    keyboard: rows,
  };
}

// ---------- عضویت / محدودیت ----------

export function joinPromptView(channelLink: string): MenuView {
  const rows: InlineButton[][] = [];
  if (channelLink) {
    rows.push([urlBtn("📢 عضویت در کانال", channelLink)]);
  }
  rows.push([btn("🔄 بررسی مجدد", { kind: "recheck" })]);
  const text = channelLink
    ? [
        "🔐 برای استفاده از امکانات ربات، ابتدا عضو کانال شوید.",
        "",
        "۱) روی دکمه «📢 عضویت در کانال» بزنید و عضو شوید.",
        "۲) سپس «🔄 بررسی مجدد» را بزنید.",
      ].join("\n")
    : [
        "🔐 برای استفاده از امکانات ربات، ابتدا عضو کانال شوید.",
        "",
        "لطفاً ابتدا در کانال عضو شوید؛ سپس «🔄 بررسی مجدد» را بزنید.",
      ].join("\n");
  return {
    text,
    keyboard: rows,
  };
}

export function membershipUnknownView(): MenuView {
  return {
    text: "⚠️ الان نمیتوان عضویت شما را بررسی کرد.\nلطفاً کمی بعد دوباره «🔄 بررسی مجدد» را بزنید.",
    keyboard: [[btn("🔄 بررسی مجدد", { kind: "recheck" })]],
  };
}

export function restrictedView(channelLink: string, supportLink: string): MenuView {
  const rows: InlineButton[][] = [[btn("📝 ثبت تیکت", { kind: "ticket_new" })]];
  if (channelLink) {
    rows.push([urlBtn("📊 کانال قیمت بازار", channelLink)]);
  }
  if (supportLink) {
    rows.push([urlBtn("🎫 پشتیبانی", supportLink)]);
  }
  return {
    text: [
      "⚠️ دسترسی شما به امکانات ربات فعال نیست.",
      "",
      "برای درخواست دسترسی، یک تیکت ثبت کنید تا پشتیبانی بررسی کند.",
    ].join("\n"),
    keyboard: rows,
  };
}

// ---------- قیمت‌ها / وضعیت ----------

/** متن قیمت‌ها آمادهشده در لایه داده است (صادقانه: داده نبود = پیام نبود داده) */
export function pricesView(priceText: string): MenuView {
  return {
    text: priceText,
    keyboard: [
      [btn("🔄 بررسی مجدد", { kind: "prices" })],
      ...backHomeRows(),
    ],
  };
}

export function statusView(statusText: string): MenuView {
  return {
    text: statusText,
    keyboard: [
      [btn("🔄 بررسی مجدد", { kind: "status" })],
      ...backHomeRows(),
    ],
  };
}

// ---------- تیکت‌های من ----------

/** بیشترین تیکتی که در فهرست دکمه‌ای نمایش داده میشود */
const MAX_LIST_BUTTONS = 10;

export function ticketListView(
  tickets: Ticket[],
  closedCount: number,
): MenuView {
  if (tickets.length === 0) {
    return {
      text:
        closedCount > 0
          ? `🎫 شما تیکت بازی ندارید.\n(${faDigits(String(closedCount))} تیکت بستهشده در تاریخچه)`
          : "🎫 هنوز تیکتی ثبت نکردهایید.\nبرای ثبت، دکمه «📝 ثبت تیکت» را بزنید.",
      keyboard: [
        [btn("📝 ثبت تیکت", { kind: "ticket_new" })],
        ...backHomeRows(),
      ],
    };
  }
  const shown = tickets.slice(0, MAX_LIST_BUTTONS);
  const rows: InlineButton[][] = shown.map((t) => [
    btn(
      `🎫 #${faDigits(String(t.id))} — ${truncate(t.subject, 24)}`,
      { kind: "ticket_view", id: t.id },
    ),
  ]);
  const extra =
    tickets.length > MAX_LIST_BUTTONS
      ? `\n\n(فقط ${faDigits(String(MAX_LIST_BUTTONS))} تیکت آخر نمایش داده میشود)`
      : "";
  return {
    text: `🎫 تیکت‌های باز شما (${faDigits(String(tickets.length))}):${extra}`,
    keyboard: [...rows, [btn("📝 ثبت تیکت", { kind: "ticket_new" })], ...backHomeRows()],
  };
}

/** بیشترین پاسخی که در جزئیات نمایش داده میشود (سقف پیام تلگرام) */
const MAX_DETAIL_REPLIES = 5;

export function ticketDetailView(ticket: Ticket): MenuView {
  const lines = [
    `🎫 تیکت #${faDigits(String(ticket.id))} — باز است`,
    SEP,
    `📌 موضوع: ${truncate(ticket.subject, 80)}`,
    `💬 پیام: ${truncate(ticket.text, 400)}`,
    `🕐 ثبت: ${faTimestamp(ticket.createdAt)}`,
  ];
  if (ticket.replies.length > 0) {
    lines.push(SEP, "گفتگو:");
    const shown = ticket.replies.slice(-MAX_DETAIL_REPLIES);
    if (ticket.replies.length > MAX_DETAIL_REPLIES) {
      lines.push(
        `(فقط ${faDigits(String(MAX_DETAIL_REPLIES))} پاسخ آخر نمایش داده میشود)`,
      );
    }
    for (const reply of shown) {
      const who = reply.from === "user" ? "👤 شما" : "🛡 پشتیبانی";
      lines.push(
        `${who} — ${faTimestamp(reply.at)}`,
        truncate(reply.text, 160),
        "",
      );
    }
  }
  return {
    text: lines.join("\n").trimEnd(),
    keyboard: [
      [btn("💬 پاسخ به پشتیبانی", { kind: "ticket_reply", id: ticket.id })],
      [btn("✅ بستن تیکت", { kind: "ticket_close_confirm", id: ticket.id })],
      ...backHomeRows(),
    ],
  };
}

export function ticketClosedView(ticketId: number): MenuView {
  return {
    text: `✅ تیکت #${faDigits(String(ticketId))} بسته شد.\nبرای موضوع جدید، «📝 ثبت تیکت» را بزنید.`,
    keyboard: [
      [btn("📝 ثبت تیکت", { kind: "ticket_new" })],
      ...backHomeRows(),
    ],
  };
}

// ---------- جریان ثبت تیکت ----------

export function ticketSubjectPromptView(): MenuView {
  return {
    text: [
      "📝 ثبت تیکت — مرحله ۱ از ۳",
      "",
      "موضوع تیکت را در یک پیام کوتاه بنویسید (حداکثر ۸۰ کاراکتر).",
      "",
      "مثال: «فعال‌سازی دسترسی ربات»",
    ].join("\n"),
    keyboard: [[btn("❌ لغو", { kind: "cancel" })]],
  };
}

export function ticketTextPromptView(subject: string): MenuView {
  return {
    text: [
      "📝 ثبت تیکت — مرحله ۲ از ۳",
      "",
      `📌 موضوع: ${truncate(subject, 80)}`,
      "",
      "حالا متن پیام را در یک پیام بنویسید (حداکثر ۵۱۲ کاراکتر).",
    ].join("\n"),
    keyboard: [[btn("❌ لغو", { kind: "cancel" })]],
  };
}

export function ticketConfirmPromptView(
  subject: string,
  text: string,
): MenuView {
  return {
    text: [
      "📝 ثبت تیکت — مرحله ۳: تأیید",
      "",
      `📌 موضوع: ${truncate(subject, 80)}`,
      `💬 پیام: ${truncate(text, 400)}`,
      "",
      "آیا تیکت ثبت شود؟",
    ].join("\n"),
    keyboard: [
      [btn("✅ تأیید ثبت", { kind: "ticket_confirm" })],
      [btn("✏️ شروع مجدد", { kind: "ticket_restart" })],
      [btn("❌ لغو", { kind: "cancel" })],
    ],
  };
}

export function ticketCreatedView(ticketId: number): MenuView {
  return {
    text: [
      `✅ تیکت #${faDigits(String(ticketId))} ثبت شد!`,
      "",
      "پشتیبانی به‌زودی بررسی میکند.",
      "از «🎫 تیکت‌های من» میتوانید پاسخ را دنبال کنید.",
    ].join("\n"),
    keyboard: [
      [btn("🎫 تیکت‌های من", { kind: "tickets" })],
      ...backHomeRows(),
    ],
  };
}

// ---------- جریان پاسخ ----------

export function replyPromptView(
  ticketId: number,
  asAdmin: boolean,
): MenuView {
  return {
    text: [
      `💬 پاسخ به تیکت #${faDigits(String(ticketId))}`,
      "",
      "پاسخ را در یک پیام بنویسید (حداکثر ۵۱۲ کاراکتر).",
    ].join("\n"),
    keyboard: [[btn("❌ لغو", { kind: "cancel" })]],
  };
}

export function closeConfirmView(ticketId: number, asAdmin: boolean): MenuView {
  return {
    text: [
      `آیا تیکت #${faDigits(String(ticketId))} بسته شود؟`,
      "",
      "پس از بستن، امکان پاسخ جدیدی نیست.",
    ].join("\n"),
    keyboard: [
      [
        asAdmin
          ? btn("✅ بله، بستن تیکت", { kind: "admin_close_yes", id: ticketId })
          : btn("✅ بله، بستن تیکت", { kind: "ticket_close_yes", id: ticketId }),
      ],
      [
        asAdmin
          ? btn("❌ انصراف", { kind: "admin_view", id: ticketId })
          : btn("❌ انصراف", { kind: "ticket_view", id: ticketId }),
      ],
    ],
  };
}

// ---------- پنل ادمین ----------

export function adminMenuView(): MenuView {
  return {
    text: "👑 پنل مدیریت\n\nمدیریت تیکت‌ها و وضعیت سیستم:",
    keyboard: [
      [btn("🎫 تیکت‌های باز", { kind: "admin_tickets" })],
      [btn("📡 وضعیت سیستم", { kind: "status" })],
      [btn("🔄 بروزرسانی کانال", { kind: "admin_refresh" })],
      [btn("↩️ بازگشت", { kind: "home" })],
    ],
  };
}

export function adminTicketListView(tickets: Ticket[]): MenuView {
  if (tickets.length === 0) {
    return {
      text: "🎫 تیکت بازی وجود ندارد.",
      keyboard: backHomeRows(),
    };
  }
  const shown = tickets.slice(0, MAX_LIST_BUTTONS);
  const rows: InlineButton[][] = shown.map((t) => [
    btn(
      `🎫 #${faDigits(String(t.id))} — ${truncate(t.subject, 20)}`,
      { kind: "admin_view", id: t.id },
    ),
  ]);
  return {
    text: `🎫 تیکت‌های باز (${faDigits(String(tickets.length))}):`,
    keyboard: [...rows, ...backHomeRows()],
  };
}

export function adminTicketDetailView(ticket: Ticket): MenuView {
  const lines = [
    `🎫 تیکت #${faDigits(String(ticket.id))} — باز است`,
    `👤 کاربر: ${faDigits(String(ticket.userId))}`,
    SEP,
    `📌 موضوع: ${truncate(ticket.subject, 80)}`,
    `💬 پیام: ${truncate(ticket.text, 400)}`,
    `🕐 ثبت: ${faTimestamp(ticket.createdAt)}`,
  ];
  if (ticket.replies.length > 0) {
    lines.push(SEP, "گفتگو:");
    const shown = ticket.replies.slice(-MAX_DETAIL_REPLIES);
    for (const reply of shown) {
      const who = reply.from === "user" ? "👤 کاربر" : "🛡 شما";
      lines.push(`${who} — ${faTimestamp(reply.at)}`, truncate(reply.text, 160), "");
    }
  }
  return {
    text: lines.join("\n").trimEnd(),
    keyboard: [
      [btn("✍️ پاسخ", { kind: "admin_reply", id: ticket.id })],
      [btn("✅ بستن تیکت", { kind: "admin_close_confirm", id: ticket.id })],
      ...backHomeRows(),
    ],
  };
}

// ---------- عمومی ----------

/** پیام راهنما برای متن نامربوط (بدون مکالمهٔ فعال) */
export function fallbackHintView(): MenuView {
  return {
    text: "برای استفاده از امکانات، از منوی زیر انتخاب کنید 👇",
    keyboard: [[btn("🏠 منوی اصلی", { kind: "home" })]],
  };
}

export function operationInvalidView(reason: string): MenuView {
  return {
    text: `⚠️ این عملیات دیگر معتبر نیست.\n${reason}`,
    keyboard: backHomeRows(),
  };
}

/** کوتاهکردن متن با «…» — برای دکمهها و پیشنمایشها */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
