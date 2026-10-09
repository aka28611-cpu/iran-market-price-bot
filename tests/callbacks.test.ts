import { describe, expect, it } from "vitest";
import {
  decodeCallback,
  encodeCallback,
  type CallbackAction,
} from "../src/telegram/callbacks";

/**
 * پروتکل callback_data — کدکد فشرده با اعتبارسنجی سخت‌گیرانه.
 * هدف تستها: هیچ رشتهٔ خارج از پروتکل پذیرفته نشود (fail-closed)
 * و طول همیشه زیر سقف ۶۴ بایت تلگرام بماند.
 */

const ALL_ACTIONS: CallbackAction[] = [
  { kind: "home" },
  { kind: "prices" },
  { kind: "status" },
  { kind: "tickets" },
  { kind: "ticket_new" },
  { kind: "ticket_confirm" },
  { kind: "ticket_restart" },
  { kind: "cancel" },
  { kind: "recheck" },
  { kind: "ticket_view", id: 12 },
  { kind: "ticket_reply", id: 345 },
  { kind: "ticket_close_confirm", id: 7 },
  { kind: "ticket_close_yes", id: 999999999 },
  { kind: "admin_home" },
  { kind: "admin_tickets" },
  { kind: "admin_view", id: 5 },
  { kind: "admin_reply", id: 6 },
  { kind: "admin_close_confirm", id: 8 },
  { kind: "admin_close_yes", id: 9 },
  { kind: "admin_refresh" },
];

describe("encodeCallback / decodeCallback — رفت و برگشت", () => {
  for (const action of ALL_ACTIONS) {
    it(`round-trip: ${action.kind}`, () => {
      expect(decodeCallback(encodeCallback(action))).toEqual(action);
    });
  }

  it("همهٔ کدها زیر سقف ۶۴ بایت تلگرام میمانند", () => {
    for (const action of ALL_ACTIONS) {
      expect(encodeCallback(action).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("decodeCallback — ورودیهای نامعتبر → null (fail-closed)", () => {
  const invalid = [
    "",
    "unknown",
    "home ",
    " home",
    "HOME",
    "tkv",
    "tkvabc",
    "tkv-1",
    "tkv0",
    "tkv1234567890", // ۱۰ رقم — بیشتر از سقف ۹ رقم
    "tkv12x",
    "adv12/",
    "admin",
    "admin:123",
    "check_membership", // پروتکل قدیمی — دیگر معتبر نیست
    "support_start", // پروتکل قدیمی
    "x".repeat(65),
    "px\x00",
  ];
  for (const data of invalid) {
    it(`"${data.slice(0, 20)}" → null`, () => {
      expect(decodeCallback(data)).toBeNull();
    });
  }
});

describe("decodeCallback — مرزهای id معتبر", () => {
  it("id = 1 و id = 999999999 معتبرند", () => {
    expect(decodeCallback("tkv1")).toEqual({ kind: "ticket_view", id: 1 });
    expect(decodeCallback("ady999999999")).toEqual({
      kind: "admin_close_yes",
      id: 999999999,
    });
  });

  it("پیشوندها با یک کاراکتر تفاوت جدا میشوند (tkc vs tkv vs tkr)", () => {
    expect(decodeCallback("tkc5")?.kind).toBe("ticket_close_confirm");
    expect(decodeCallback("tkv5")?.kind).toBe("ticket_view");
    expect(decodeCallback("tkr5")?.kind).toBe("ticket_reply");
    expect(decodeCallback("tky5")?.kind).toBe("ticket_close_yes");
  });
});
