# iran-market-price-bot 🇮🇷

ربات تلگرام مستقل برای دریافت قیمت‌های بازار ایران و انتشار خودکار در یک کانال تلگرام،
بر پایه **Cloudflare Worker + Cron Triggers + Telegram Bot API** (زبان: TypeScript).

> **وضعیت فعلی — مرحله ۲ (Push + Deploy):** Worker روی Cloudflare مستقر است (Cron هر ۱ دقیقه و هر ۶ ساعت + KV STATE)؛ تا تنظیم Secretها همه جابها به‌صورت fail-closed رد می‌شوند (بدون هیچ تماس خارجی) و هیچ وب‌هوکی ثبت نشده است.
> **مرحله جدید — عضویت اجباری/دسترسی/تیکت (کد محلی، هنوز Deploy نشده):** جریان /start کاربر،
> بررسی عضویت سه‌حالته، allowlist، callback دکمه‌ها و تیکت پشتیبانی پیاده و تست شده است (۲۴۲ تست سبز).
> ساختار کامل پروژه، جاب‌های زمان‌بندی، فرمتر پیام، دستورات ادمین و مجموعه تست‌ها آماده است؛
> اما **provider قیمت هنوز متصل نشده** (`PRICE_PROVIDER=stub` عمداً هیچ داده‌ای تولید نمی‌کند)
> و **هیچ Secret واقعی تنظیم نشده است**. طبق سیاست پروژه: هیچ API واقعی بدون مشخص‌شدن
> provider هارد-کد نمی‌شود و هیچ مقدار ساختگی/تخمینی هم تولید نمی‌شود.

---

## معماری

```
Price API (provider)
        ↓
Cloudflare Worker   GET  /healthz           → {"ok":true} (حداقلی، بدون diagnostic)
                   POST /telegram/webhook   → دستورات ادمین (رمزدار)
        ↓
Cron Trigger «* * * * *»  هر ۱ دقیقه
        → دلار فردایی تهران: خرید / فروش / معامله / زمان آخرین بروزرسانی
        → editMessageText روی «یک پیام ثابت» (message_id در KV) — پیام جدیدی ساخته نمی‌شود
        ↓
Telegram Bot API → Telegram Channel

Cron Trigger «0 */6 * * *»  هر ۶ ساعت
        → گزارش کامل بازار: ارز / طلا / سکه (فقط موارد موجود در provider)
        → sendMessage جدید به کانال
```

## ساعت بازار (Market Hours)

ماژول `src/market-hours.ts` — **منبع یگانه** ساعت‌های بازار؛ هیچ فایل دیگری ساعت بازار را hard-code نمی‌کند:

| وضعیت | رفتار |
|---|---|
| `OPEN` | روال عادی: دریافت از provider ← اعتبارسنجی کامل (شامل تازگی) ← انتشار |
| `CLOSED` | provider صدا زده نمی‌شود؛ پیام ثابت با «آخرین قیمت معتبر» ذخیره‌شده در KV + نشان «بازار بسته است» |
| `UNKNOWN` | **fail-closed** — هیچ چیزی منتشر نمی‌شود (قیمت مشکوک ممنوع؛ بدون fetch و بدون ارسال) |

- Timezone: `Asia/Tehran` (بدون DST — هماهنگ با `src/datetime.ts`)
- تعطیلی هفتگی: روزهای بدون پنجره (پیش‌فرض: جمعه)
- تعطیلات رسمی: لیست `holidays` در همان فایل، به تاریخ «YYYY-MM-DD» تهران — قابل توسعه
- توسعه‌پذیری: ساختار `sessions` برای instrument/providerهای مختلف (هر session پنجره‌های خودش را دارد)
- پیش‌فرض فعلی: شنبه تا چهارشنبه ۰۹:۰۰–۱۹:۰۰ | پنجشنبه نیم‌روز ۰۹:۰۰–۱۳:۰۰ | جمعه تعطیل

## قابلیت‌ها

### هر ۵ دقیقه — پیام ثابت دلار و تتر
- قالب مالک پروژه: «معامله» (نرخ واحد دلار) + خط تتر مستقل (قالب HTML بولد)
- پیام **ثابت** کانال با `editMessageText` بروزرسانی می‌شود (id پیام در KV ذخیره است)
- «هر ۵ دقیقه» = کادنسِ بررسی، نه تضمین تغییر: دادهٔ بی‌تغییر از منبع = هیچ تماس
  تلگرام و هیچ ادعای تازگی (status `ok/UNCHANGED`)
- فقط در ساعت بازِ بازار fetch می‌کند (منطق `market-hours.ts`)؛ بسته → کش + نشان بسته
- **اعتبارسنجی متقاطع قبل از انتشار مقدار جدید** (بند ۳ ممیزی ۲۰۲۶-۱۰-۱۱ — بخش بعدی)

> محدودیت پلتفرم (Cloudflare Cron Triggers): حداقل ۱ دقیقه گرانولاریته،
> تأخیر دقیقه‌ای در اجرا، «حداقل یکبار» (at-least-once) — کادنس ۵ دقیقه‌ای
> best-effort است. سقف: ۵ trigger per account (پلن رایگان) — این پروژه ۲
> trigger دارد.

### هر ۶ ساعت — گزارش بازار
- ارز: دلار، تتر، یورو، پوند، لیر، درهم (در صورت وجود)
- طلا: ۱۸ عیار، ۲۴ عیار (آب‌شده)، اونس جهانی
- سکه: امامی، بهار آزادی، نیم، ربع، گرمی
- هر آیتمی که در provider نباشد از پیام حذف می‌شود — **هیچ مقدار ساختگی جایگزین نمی‌شود**
- گارد اجرای تکراری cron: ارسال موفقِ تازه (< ۳۰ دقیقه) → این اجرا suppress
  (جلوگیری از دو گزارش در کانال — Cron «حداقل یکبار» اجرا میشود)

### اعتبارسنجی متقاطع (Cross-Check) — src/providers/cross-check.ts

قبل از انتشار هر مقدار «تغییرکرده»، منبع اصلی با مرجع مستقل مقایسه میشود:

| مرجع | پوشش | نقش | هزینه |
|---|---|---|---|
| `call1.tgju.org/ajax.json` | ارز + طلا + سکه (ریالی → تومان) | آشکارساز خرابی سمت منبع اصلی (واحد/قطع/مقدار خراب/کهنگی نسبی) | رایگان، بدون کلید |
| `api.wallex.ir/v1/depth?symbol=USDTTMN` | تتر | مرجع «واقعاً مستقل» (دفتر سفارش صرافی) | رایگان، بدون کلید |

- آستانه‌ها بر اساس نوسان طبیعی گروه بازار، قابل‌تنظیم از env:
  ارز ۲.۵٪ / طلا و سکه ۵٪ / تتر ۳٪ (پیش‌فرض)
- **اختلاف بیش از آستانه** → دلار: عدم انتشار کل پیام (status `invalid`،
  دلیل ثبت میشود)؛ تتر: حذف خط تتر؛ آیتم گزارش: حذف آیتم — هرگز نادیده/جایگزین نه
- **مرجع قطع/نامعتبر** → دو رفتار (دستور مالک ۲۰۲۶-۱۰-۱۱):
  تتر = fail-closed (خط تتر منتشر نمیشود — مقدار قبلی هم «نرخ تازه» فرض
  نمیشود)؛ ارز/طلا/سکه = advisory (انتشار ادامه + لاگ؛ مرجعِ رایگان نقطهٔ
  شکست انتشار نیست). قطع مرجع فقط در لاگ و status KV ثبت میشود — هیچ
  متن فنی/خطا به پیام عمومی کانال نمیرود.
- **خروجی عمومی فقط ارقام انگلیسی** (دستور مالک ۲۰۲۶-۱۰-۱۱): قیمت، تاریخ،
  ساعت و درصد در پیام ثابت و گزارش ۶ ساعته همگی با ارقام 0-9 و جداکنندهٔ
  «,»/«.» — هیچ رقم/جداکنندهٔ فارسی یا عربی در کانال نیست (متن فارسی و
  نام داراییها حفظ میشود).
- **خطای منبع/دادهٔ قدیمی** → پیام عمومی قبلی حفظ میشود (هیچ پیام خطا
  جایگزین نمیشود)؛ داده قدیمی هرگز به‌عنوان نرخ جدید منتشر نمیشود.
- صرفهٔ درخواست: چک فقط برای مقدار «در حال انتشار» اجرا میشود (UNCHANGED →
  بدون fetch مرجع) — در عمل چند fetch در روز، نه صدها
- **نکتهٔ صداقت**: مقادیر jahankhahan با TGJU یکسان است (اختلاف ۰٪ — همان
  بالادست)؛ Wallex برای تتر مستقل واقعی است. جزئیات و شواهد: `docs/SOURCES.md`

### زمان‌بندی Cron (خلاصه)

| Cron | دامنه | رفتار |
|---|---|---|
| `*/5 * * * *` | دلار + تتر | OPEN → fetch + edit؛ CLOSED → کش + نشان بسته؛ UNCHANGED → بدون تماس |
| `0 */6 * * *` | همهٔ ارزها/طلا/سکه‌ها + تتر | گزارش کامل (sendMessage) + اعتبارسنجی متقاطع آیتمها |

- تلاقی دو عبارت (۰۰:۰۰/۰۶:۰۰/۱۲:۰۰/۱۸:۰۰ UTC): هر trigger فراخوانی
  `scheduled` خودش را میگیرد (`event.cron` متفاوت) → بدون تداخل KV/تلگرام
- قفل مشورتی KV (`lock:usd:send`، TTL 60s) روی ارسال اولین پیام ثابت —
  بهترین تلاش (KV اتمی نیست؛ مستند در ممیزی). راه‌حل اتمی: Durable Objects (آینده)

### دستورات ادمین (فقط `ADMIN_USER_ID`)
| دستور | کارکرد |
|---|---|
| `/start` | معرفی و فهرست دستورات |
| `/status` | وضعیت ربات: provider، آخرین اجراها، آخرین قیمت، وضعیت pause |
| `/price` | دریافت فوری قیمت دلار (فقط برای نمایش به ادمین) |
| `/update` | اجرای فوری جاب ۱ دقیقه و گزارش نتیجه |
| `/pause` | توقف انتشار خودکار |
| `/resume` | ادامه انتشار خودکار |
| `/test` | ارسال پیام آزمایشی به کانال پیکربندی‌شده |
| `/allow <user_id>` | افزودن کاربر به فهرست مجاز |
| `/revoke <user_id>` | حذف دسترسی کاربر |
| `/users` | فهرست کاربران مجاز |
| `/tickets` | تیکت‌های باز (همه کاربران) |
| `/ticket_close <id>` | بستن تیکت + اطلاع به کاربر |

### جریان کاربر — منوی دکمه‌ای (بازطراحی round 15)

تعاملات اصلی از طریق منوی دکمه‌ای انجام می‌شود (بدون نیاز به حفظ دستورها):
`📊 قیمت‌های بازار` | `📡 وضعیت ربات` | `📝 ثبت تیکت` | `🎫 تیکت‌های من` | `🏠 منوی اصلی` | `🔄 بررسی مجدد` | `↩️ بازگشت`
ناوبری با `editMessageText` در همان پیام انجام می‌شود (چت شلوغ نمیشود)؛
callbackها فشرده و اعتبارسنجی سخت‌گیرانه دارند (fail-closed).
جریان تیکت سه‌مرحله‌ای (موضوع → متن → تأیید) با دکمه «لغو» و ماشین‌وضعیت KV
(TTL ۱۰ دقیقه) پیاده شده است؛ گفتگوی تیکت (پاسخ کاربر/پشتیبانی) و بستن تیکت
هم دکمه‌ای است. پنل ادمین (`👑 پنل مدیریت`) تیکت‌های باز، جزئیات، پاسخ و بستن
را با دکمه انجام میدهد.

### جریان کاربر — عضویت اجباری + دسترسی دوگاته
```
/start (کاربر غیرادمین)
  |
  | 1) بررسی عضویت کانال (سمت سرور getChatMember — سه‌حالته)
  |    |-- خطای API → «بررسی ممکن نیست» (fail-closed — هرگز «عدم عضویت» نیست)
  |    `-- غیرعضو → پیام عضویت + دکمه «📊 عضویت در کانال قیمت ارز» + «✅ بررسی عضویت»
  |
  `-- 2) عضو → بررسی مجوز (allowlist در KV — عضویت به‌تنهایی مجوز نیست)
       |-- بدون مجوز → پیام «⚠️ دسترسی غیرمجاز» + دکمه کانال + «🎫 پشتیبانی و ثبت تیکت»
       `-- مجاز → دستورات کاربر: /price /report /status
```
- بررسی عضویت و مجوز روی **هر** دستور و callback سمت سرور اعمال می‌شود — دورزدن ممکن نیست
- جریان کاربر فقط در چت خصوصی (chat.id === from.id) — بدون نشت به گروه
- دکمه‌ی کانال فقط با لینک واقعی (CHANNEL_LINK یا @username)؛ غایب = دکمه حذف می‌شود

### پشتیبانی و تیکت (مسیر فرار — برای همه کاربران)
- `/ticket <متن>` — ثبت تیکت (حتی برای کاربر غیرعضو/غیرمجاز) + اطلاع ادمین
- `/mytickets` — پیگیری فقط تیکت‌های خود کاربر (فیلتر سمت سرور userId)
- سقف‌ها: ۳ تیکت باز per user، ۱۰۰ تیکت باز کل، تاریخچه ۲۰ تیکت بسته per user
- متن خام بدون parse_mode — هیچ تزریق HTML/Markdown ممکن نیست

### دستورات کاربر مجاز
| دستور | کارکرد |
|---|---|
| `/price` | گزارش لحظه‌ای بازار (فرمت گزارش ۶ ساعته) — مسیر جدا از /price ادمین |
| `/report` | آخرین گزارش ذخیره‌شده KV (بدون fetch جدید) |
| `/status` | وضعیت ساده (بدون جزئیات مدیریتی) |

## ساختار پروژه

```
├── wrangler.toml              تنظیمات Worker + Cronها + KV
├── src/
│   ├── index.ts               ورودی Worker (fetch + scheduled)
│   ├── router.ts              سطح HTTP حداقلی (healthz + webhook)
│   ├── env.ts                 اعتبارسنجی fail-closed متغیرها
│   ├── types.ts               تایپ‌های دامنه (قیمت/گزارش)
│   ├── logging.ts             لاگ JSON با redaction خودکار Secret
│   ├── ratelimit.ts           rate limit درون-حافظه‌ای
│   ├── validation.ts          اعتبارسنجی قیمت (بدون fallback)
│   ├── datetime.ts            تاریخ شمسی + ساعت تهران + ارقام فارسی
│   ├── market-hours.ts        ساعت بازار (OPEN/CLOSED/UNKNOWN) — منبع یگانه
│   ├── state.ts               وضعیت ربات در KV
│   ├── auth/                  authentication و authorization
│   ├── providers/             PriceProvider interface + stub + registry
│   ├── telegram/              کلاینت Bot API + فرمتر + دستورات
│   └── scheduler/             dispatch کرون + جاب ۱ دقیقه + جاب ۶ ساعت
└── tests/                     تستهای واحد Vitest (شامل اسکن Secret)
```

## مدل امنیتی (fail-closed)

| الزام | پیاده‌سازی |
|---|---|
| Admin User ID authorization | بررسی `from.id === ADMIN_USER_ID` قبل از هر پاسخ مدیریتی |
| عضویت اجباری کانال | `getChatMember` سمت سرور — سه‌حالته؛ خطای API ≠ عدم عضویت (fail-closed) |
| عضویت ≠ مجوز | گات جداگانه allowlist KV روی هر دستور/callback |
| امنیت callback | شناسه فقط از `callback_query.from.id` سرور؛ data فقط «نوع اقدام» از whitelist |
| مالکیت تیکت | فیلتر سمت سرور بر اساس userId — تیکت دیگران قابل مشاهده نیست |
| Telegram webhook secret | هدر `X-Telegram-Bot-Api-Secret-Token` با مقایسه زمان-ثابت |
| Cloudflare Secrets | فقط `wrangler secret put` — هیچ Secret در Git/کد نیست |
| API key isolation | `PRICE_API_KEY` جدا از توکن ربات؛ فقط provider استفاده می‌کند |
| Channel ID allowlist | مقصد انتشار فقط `CHANNEL_ID` از env — هرگز از chat_id کاربر |
| Input validation | اعتبارسنجی env / ساختار update / مقادیر قیمت |
| Timeout | AbortController ~۱۰ ثانیه برای Telegram (و provider در پیاده‌سازی بعدی) |
| Error handling | خطاها هرگز به انتشار قیمت نامعتبر نمی‌انجامند |
| Rate limiting | درون-حافظه‌ای برای healthz، دستورات و callback (محدودیت isolate مستند است) |
| Secure logging | JSON خطی؛ کلیدهای حساس و مقادیر شبیه توکن [REDACTED] می‌شوند |
| عدم hard-code credential | هیچ credential در کد وجود ندارد |
| عدم endpoint مدیریتی عمومی | سطح HTTP فقط /healthz و /telegram/webhook |
| عدم انتشار قیمت نامعتبر | قیمت کهنه/خراب → skip کامل انتشار |
| عدم انتشار در UNKNOWN بازار | ارزیابی ساعت بازار قبل از انتشار؛ UNKNOWN = skip کامل (بدون fetch و بدون ارسال) |
| عدم fallback ساختگی | stub هم null برمی‌گرداند؛ هیچ عدد جعلی ارسال نمی‌شود |

## متغیرهای محیطی

| نام | نوع | الزام | توضیح |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | اجباری | توکن ربات از BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | اجباری | secret_token وب‌هوک (≥۱۶ کاراکتر؛ ۳۲+ توصیه می‌شود) |
| `ADMIN_USER_ID` | Secret | اجباری | user id عددی ادمین |
| `CHANNEL_ID` | Secret | اجباری | کانال مقصد ( `-100…` یا `@username` ) |
| `PRICE_API_KEY` | Secret | اختیاری | کلید provider (در صورت نیاز) |
| `PRICE_PROVIDER` | Var | اختیاری | `stub` (پیش‌فرض) — پس از پیاده‌سازی: نام provider |
| `PRICE_API_BASE_URL` | Var | اختیاری | آدرس provider (بدون hard-code در کد) |
| `CHANNEL_LINK` | Var | اختیاری | لینک عمومی کانال (فقط `https://t.me/...`) — دکمه عضویت؛ خالی + `@username` → از username ساخته می‌شود |
| `SUPPORT_LINK` | Var | اختیاری | لینک خارجی پشتیبانی — خالی = سیستم تیکت داخلی ربات |
| `CROSS_CHECK_ENABLED` | Var | اختیاری | فعال/غیرفعال بودن اعتبارسنجی متقاطع (پیش‌فرض: فعال) |
| `CROSS_CHECK_FX_TOLERANCE_PCT` | Var | اختیاری | آستانهٔ اختلاف ارزها — درصد (پیش‌فرض ۲.۵) |
| `CROSS_CHECK_GOLD_TOLERANCE_PCT` | Var | اختیاری | آستانهٔ اختلاف طلا/سکه — درصد (پیش‌فرض ۵) |
| `CROSS_CHECK_TETHER_TOLERANCE_PCT` | Var | اختیاری | آستانهٔ اختلاف تتر — درصد (پیش‌فرض ۳) |
| `TGJU_REFERENCE_URL` | Var | اختیاری | مرجع TGJU (پیش‌فرض: call1.tgju.org/ajax.json — فقط https) |
| `WALLEX_MARKETS_URL` | Var | اختیاری | مرجع تتر Wallex (پیش‌فرض: depth USDTTMN — فقط https) |

> مقدارها را هرگز در Git قرار ندهید. Production: `wrangler secret put NAME`
> و اجرای محلی: فایل `.dev.vars` (از روی `.dev.vars.example`).

## راه‌اندازی

### پیش‌نیازها
- Node.js ≥ 18 و npm
- اکانت Cloudflare (برای deploy بعدی)
- یک Telegram Bot Token و یک کانال + user id ادمین

### گام‌ها
```bash
# ۱) نصب وابستگی‌ها (فقط devDependencies — بدون وابستگی runtime)
npm install

# ۲) تستها و typecheck
npm run typecheck
npm test

# ۳) اجرای محلی
cp .dev.vars.example .dev.vars   # مقادیر تستی خود را بگذارید
npm run dev                       # wrangler dev → http://localhost:8787

# ۴) (برای deploy بعدی) KV بسازید و id را در wrangler.toml جایگزین کنید
npx wrangler kv namespace create STATE

# ۵) (برای deploy بعدی) Secretها را تنظیم کنید
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_USER_ID
npx wrangler secret put CHANNEL_ID

# ۶) (برای deploy بعدی) وب‌هوک را با secret_token تنظیم کنید
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://<WORKER_URL>/telegram/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

> در مرحله ۲، `npx wrangler deploy` اجرا شده است؛ `<PLACEHOLDER>`ها
> فقط الگو هستند — مقدار واقعی در هیچ فایلی ذخیره نمی‌شود.

## تستها

```bash
npm test          # کل مجموعه (Vitest)
npm run test:watch
npm run typecheck # tsc --noEmit
```

پوشش فعلی: اعتبارسنجی env، اعتبارسنجی قیمت، تاریخ شمسی/تهران، ساعت بازار (OPEN/CLOSED/UNKNOWN)، فرمتر پیامها،
authentication (زمان-ثابت/ادمین/allowlist)، **عضویت سه‌حالته + مجوز (access)**،
**جریان کامل /start و callback‌ها**، **تیکت (سقف‌ها/مالکیت/بستن)**، registry provider (fail-closed)،
دستورات ادمین + مدیریت دسترسی، سطح HTTP (healthz/webhook/404/429)، جاب ۱ دقیقه (edit پیام ثابت)،
جاب ۶ ساعت و **اسکن بهداشت Secret کل مخزن**.

## افزودن Provider واقعی (مرحله بعد)

1. مشخص شدن provider و endpoint و نحوه احراز آن
2. پیاده‌سازی `PriceProvider` در `src/providers/<name>.ts`
   (تنظیمات فقط از env: `PRICE_API_BASE_URL` / `PRICE_API_KEY`؛ timeout با AbortController)
3. ثبت نام provider در `src/providers/registry.ts`
4. تستهای اختصاصی provider با fetch فیک
5. تنظیم `PRICE_PROVIDER=<name>` به‌عنوان Var

## قواعد امنیتی پروژه (فراتر از کد)

- هیچ Secret/Token در chat، source، README یا Git قرار نمی‌گیرد
- `.env`، `.dev.vars` و credentialها همیشه gitignore هستند
- tokenها به‌محض افشای احتمالی revoke و rotate می‌شوند
- هیچ security warning با غیرفعال‌سازی validation دور نمی‌زنم
