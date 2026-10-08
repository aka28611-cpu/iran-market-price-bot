import { describe, expect, it } from "vitest";
import { isAllowedPublishTarget } from "../src/auth/allowlist";
import { timingSafeEqual } from "../src/auth/constant-time";
import {
  extractUpdateMessage,
  isAuthorizedAdmin,
  parseCommandName,
  verifyWebhookSecret,
} from "../src/auth/telegram-auth";

const SECRET = "s3cret-value-0123456789";

describe("timingSafeEqual — مقایسه زمان-ثابت", () => {
  it("رشتههای برابر را می‌پذیرد", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("رشتههای متفاوت را رد می‌کند", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("طولهای متفاوت را رد می‌کند", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });
});

describe("verifyWebhookSecret — هدر وب‌هوک", () => {
  it("secret درست را می‌پذیرد", () => {
    expect(verifyWebhookSecret(SECRET, SECRET)).toBe(true);
  });

  it("هدر مفقود (null) را رد می‌کند", () => {
    expect(verifyWebhookSecret(null, SECRET)).toBe(false);
  });

  it("secret غلط را رد می‌کند", () => {
    expect(verifyWebhookSecret("wrong-secret-value", SECRET)).toBe(false);
  });
});

describe("extractUpdateMessage — استخراج امن", () => {
  it("message معتبر خصوصی را استخراج می‌کند", () => {
    const update = {
      message: {
        text: "/status",
        chat: { id: 100200300 },
        from: { id: 100200300 },
      },
    };
    expect(extractUpdateMessage(update)).toEqual({
      text: "/status",
      chatId: 100200300,
      fromId: 100200300,
    });
  });

  it("updateهای خراب را رد می‌کند", () => {
    expect(extractUpdateMessage(null)).toBeNull();
    expect(extractUpdateMessage("x")).toBeNull();
    expect(extractUpdateMessage({})).toBeNull();
    expect(extractUpdateMessage({ message: { text: 123 } })).toBeNull();
    expect(
      extractUpdateMessage({ message: { text: "x", chat: {}, from: {} } }),
    ).toBeNull();
  });

  it("idهای غیر صحیح را رد می‌کند", () => {
    expect(
      extractUpdateMessage({
        message: { text: "x", chat: { id: 1.5 }, from: { id: 1 } },
      }),
    ).toBeNull();
  });

  it("متن خیلی طولانی را رد می‌کند", () => {
    expect(
      extractUpdateMessage({
        message: {
          text: "x".repeat(600),
          chat: { id: 1 },
          from: { id: 1 },
        },
      }),
    ).toBeNull();
  });
});

describe("isAuthorizedAdmin — فقط ADMIN_USER_ID", () => {
  it("فقط id دقیق ادمین مجاز است", () => {
    expect(isAuthorizedAdmin(100200300, 100200300)).toBe(true);
    expect(isAuthorizedAdmin(100200301, 100200300)).toBe(false);
    expect(isAuthorizedAdmin(0, 100200300)).toBe(false);
  });
});

describe("isAllowedPublishTarget — allowlist مقصد", () => {
  it("فقط CHANNEL_ID پیکربندی‌شده مجاز است", () => {
    expect(isAllowedPublishTarget("-1001234567890", "-1001234567890")).toBe(
      true,
    );
    expect(isAllowedPublishTarget("-1001234567890", "-1009999999999")).toBe(
      false,
    );
    expect(isAllowedPublishTarget("-1001234567890", "12345")).toBe(false);
  });
});

describe("parseCommandName", () => {
  it("دستور ساده و با پسوند @bot را می‌پذیرد", () => {
    expect(parseCommandName("/start")).toBe("start");
    expect(parseCommandName("/status@my_market_bot")).toBe("status");
  });

  it("متن غیردستوری و دستور با آرگومان را رد می‌کند", () => {
    expect(parseCommandName("hello")).toBeNull();
    expect(parseCommandName("/start extra")).toBeNull();
    expect(parseCommandName("start")).toBeNull();
  });
});
