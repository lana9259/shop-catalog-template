/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ معماری جدید (جایگزین کامل نسخه‌ی مبتنی بر گیت‌هاب):
 *
 * به‌جای این‌که عکس‌ها را از قبل، دستی، در یک مخزن گیت‌هاب کپی کنیم (که
 * هم به یک توکن گیت‌هاب و تمدید سالانه‌اش نیاز داشت، هم سرعتش محدود به
 * چند ده عکس در ساعت بود)، این نسخه از یک مسیر پروکسیِ عکس با کش لبه‌ایِ
 * رایگان و بی‌سقفِ خودِ Cloudflare (Cache API) استفاده می‌کند:
 *
 *   GET /img?u=<آدرس عکس روی سایت فروشنده>
 *
 *   ۱) اول چک می‌کند این عکس قبلاً در کش لبه‌ای Cloudflare هست یا نه.
 *      اگر بود، مستقیم همان را با کیفیت کامل برمی‌گرداند — هیچ درخواستی
 *      به سایت فروشنده نمی‌رود.
 *   ۲) اگر نبود، Worker یک‌بار (فقط همان یک‌بار) آن عکس را از سایت
 *      فروشنده می‌گیرد، در کش لبه‌ای (برای یک سال) ذخیره می‌کند، و همان
 *      لحظه هم تحویل می‌دهد.
 *   ۳) اگر فروشنده کلید Gemini خودش را وارد کرده باشد (کارت «۲» در
 *      صفحه‌ی landing، پایین‌تر)، همان لحظه‌ی اولین دیدنِ یک عکس، یک‌بار
 *      روی آن OCR هم اجرا می‌شود و نتیجه در KV همین Worker ذخیره می‌شود؛
 *      این کار هرگز جلوی تحویل عکس را نمی‌گیرد (با ctx.waitUntil در
 *      پس‌زمینه اجرا می‌شود).
 *
 * نتیجه: هیچ سقفی روی تعداد عکس‌ها نیست (چون فقط عکس‌هایی که واقعاً
 * دیده می‌شوند کش می‌شوند، نه همه‌ی کاتالوگ از پیش)، هیچ توکن گیت‌هاب یا
 * حساب اضافه‌ای لازم نیست، و فروشنده هیچ قدم جدیدی برای این بخش انجام
 * نمی‌دهد.
 *
 * مسیر GET /catalog هم به همین مناسبت تغییر کرده: هر بار که کاتالوگ
 * درخواست می‌شود، برای هر محصولی که قبلاً حداقل یک‌بار عکسش دیده و OCR
 * شده، متن OCR ذخیره‌شده به‌صورت خودکار در پاسخ ادغام می‌شود (فیلد
 * ocr_text). این پاسخ خودش هم در کش لبه‌ای Cloudflare (۳ دقیقه) نگه
 * داشته می‌شود تا این ادغام باعث فشار زیاد روی KV نشود.
 *
 * چرخه‌ی ساعتی self-refresh حالا فقط همان کار اصلی‌اش (خزش متن محصولات)
 * را انجام می‌دهد — هیچ آپلود عکس یا OCR زمان‌بندی‌شده‌ای دیگر در آن
 * نیست، چون هر دو حالا «تنبل» (در لحظه‌ی اولین بازدید) اجرا می‌شوند.
 *
 * هیچ منطق دیگری (مسیرهای /، /internal-token، /setup، /update، دکمه‌ی
 * «اتصال خودکار»، Cron Trigger) تغییر نکرده است.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";
const OCR_CONFIG_KEY = "ocr-config";
const OCR_TEXT_PREFIX = "ocr:";

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
const CENTRAL_SERVER_URL = "https://shop-assistant.laana9258.workers.dev";

// تنظیمات مخصوص چرخه‌ی خودکار ساعتی (self-refresh) — فقط خزش متن.
const SELF_REFRESH_BOT_UA =
  "SA-ShopSelfRefresh/1.0 (+https://ai-assistant-cpl.pages.dev/bot-info)";
const SELF_REFRESH_FETCH_TIMEOUT_MS = 10000;
const SELF_REFRESH_MAX_RESPONSE_CHARS = 900000;
const SELF_REFRESH_MAX_PAGES = 18;
const SELF_REFRESH_MAX_PRODUCTS = 200;
const SELF_REFRESH_PRODUCT_PATH_HINTS = ["/product", "/products", "/shop/", "/item/", "/p/"];

// تنظیمات مخصوص اعتبارسنجی کلید Gemini (برای کارت OCR در landing).
const GENERIC_VALIDATE_TIMEOUT_MS = 10000;

// ‼️ جدید — تنظیمات مخصوص پروکسی عکس (Cache API لبه‌ای Cloudflare).
const IMG_PROXY_FETCH_TIMEOUT_MS = 15000;
const IMG_MAX_BYTES = 15 * 1024 * 1024; // سقف ۱۵ مگابایت برای هر عکس؛ فقط برای جلوگیری از سوءاستفاده
const IMG_PROXY_CACHE_SECONDS = 60 * 60 * 24 * 365; // یک سال

// ‼️ جدید — تنظیمات مخصوص OCR تنبل (اجرا در لحظه‌ی اولین دیدن هر عکس).
const OCR_GEMINI_MODEL = "gemini-3.1-flash-lite"; // همان مدلی که app.js برای چت هم استفاده می‌کند
const OCR_GEMINI_TIMEOUT_MS = 12000;
const OCR_MAX_TEXT_CHARS = 2000;
const OCR_EMPTY_MARKER = "(بدون متن)";

// ‼️ جدید — کش لبه‌ای پاسخ /catalog، تا ادغام ocr_text فشار زیادی روی KV نگذارد.
const CATALOG_EDGE_CACHE_SECONDS = 180; // ۳ دقیقه

function json(data, status, extraHeaders) {
  var headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  if (extraHeaders) {
    for (var k in extraHeaders) headers[k] = extraHeaders[k];
  }
  return new Response(JSON.stringify(data), { status: status || 200, headers: headers });
}

function html(content, status) {
  return new Response(content, {
    status: status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function getOrCreateToken(env) {
  var token = await env.CATALOG_KV.get(TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "");
    await env.CATALOG_KV.put(TOKEN_KEY, token);
  }
  return token;
}

function isPrivateOrDisallowedHost(hostname) {
  if (!hostname) return true;
  var h = hostname.toLowerCase();

  if (h === "localhost" || h === "0.0.0.0" || h === "127.0.0.1" || h === "::1" || h === "::") return true;
  if (h.indexOf(".localhost") !== -1) return true;

  var ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    var a = parseInt(ipv4[1], 10);
    var b = parseInt(ipv4[2], 10);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }

  if (h.indexOf(":") !== -1) {
    if (h === "::1" || h.indexOf("fe80:") === 0 || h.indexOf("fc") === 0 || h.indexOf("fd") === 0) return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════════════════
// کمکی‌های مشترک: هش SHA-256 و تبدیل به Base64
// ══════════════════════════════════════════════════════════════════════

async function sha256HexFromString(str) {
  var encoder = new TextEncoder();
  var data = encoder.encode(str);
  var digest = await crypto.subtle.digest("SHA-256", data);
  var bytes = new Uint8Array(digest);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var h = bytes[i].toString(16);
    if (h.length < 2) h = "0" + h;
    hex += h;
  }
  return hex;
}

function uint8ToBase64(bytes) {
  var CHUNK_SIZE = 8192;
  var binary = "";
  for (var i = 0; i < bytes.length; i += CHUNK_SIZE) {
    var chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ══════════════════════════════════════════════════════════════════════
// پیکربندی کلید Gemini برای OCR (کارت «۲» در صفحه‌ی landing)
// ══════════════════════════════════════════════════════════════════════

async function validateGeminiKey(apiKey) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, GENERIC_VALIDATE_TIMEOUT_MS);

  try {
    var endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      OCR_GEMINI_MODEL +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

    var res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "فقط یک کلمه به فارسی بنویس: تست" }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 400) {
      return { ok: false, error: "کلید Gemini نامعتبر است. مطمئن شوید آن را کامل و درست کپی کرده‌اید." };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "این کلید اجازه‌ی دسترسی ندارد. یک کلید تازه از Google AI Studio بسازید." };
    }
    if (res.status === 429) {
      return { ok: false, error: "سهمیه‌ی رایگان این کلید موقتاً پر شده؛ چند دقیقه دیگر دوباره تلاش کنید." };
    }
    if (!res.ok) {
      return { ok: false, error: "سرویس Gemini پاسخ غیرمنتظره‌ای داد (HTTP " + res.status + ")." };
    }

    return { ok: true };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: "اتصال به سرویس Gemini برقرار نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید." };
  }
}

async function handleSaveOcrConfig(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "بدنه‌ی درخواست نامعتبر است" }, 400);
  }
  if (!body || !body.geminiApiKey) {
    return json({ error: "کلید Gemini لازم است" }, 400);
  }

  var apiKey = String(body.geminiApiKey).trim();
  if (!apiKey) {
    return json({ error: "کلید نمی‌تواند خالی باشد" }, 400);
  }

  var validation = await validateGeminiKey(apiKey);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  await env.CATALOG_KV.put(
    OCR_CONFIG_KEY,
    JSON.stringify({
      geminiApiKey: apiKey,
      savedAt: Date.now(),
    })
  );

  return json({
    ok: true,
    message: "کلید OCR با موفقیت متصل و تأیید شد.",
  });
}

async function handleOcrConfigStatus(env) {
  var raw = await env.CATALOG_KV.get(OCR_CONFIG_KEY);
  if (!raw) {
    return json({ configured: false });
  }
  var cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return json({ configured: false });
  }
  return json({
    configured: true,
    savedAt: cfg.savedAt || null,
  });
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ جدید — پروکسی عکس با کش لبه‌ای Cloudflare + OCR تنبل
// ══════════════════════════════════════════════════════════════════════

// از bytes یک عکس (که پروکسی همین الان دانلود کرده)، متن ریز رویش را
// با Gemini استخراج می‌کند. هرگز throw نمی‌کند؛ در هر مشکلی رشته‌ی خالی
// برمی‌گرداند.
async function extractOcrTextFromImageBytes(geminiApiKey, base64Data, contentType) {
  var endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    OCR_GEMINI_MODEL +
    ":generateContent?key=" +
    encodeURIComponent(geminiApiKey);

  var body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "تمام متن‌ها و نوشته‌های ریزی که روی این تصویر محصول دیده می‌شوند را دقیقاً همان‌طور که نوشته شده‌اند، کلمه‌به‌کلمه استخراج کن. " +
              "اگر روی تصویر هیچ متنی وجود ندارد، فقط دقیقاً همین عبارت را بنویس: " +
              OCR_EMPTY_MARKER +
              ". هیچ توضیح اضافه‌ای، مقدمه، یا جمله‌ی دیگری ننویس؛ فقط خودِ متن استخراج‌شده (یا آن عبارت) را برگردان.",
          },
          { inlineData: { mimeType: contentType, data: base64Data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 512 },
  };

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, OCR_GEMINI_TIMEOUT_MS);

  var res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    return "";
  }
  clearTimeout(timeoutId);
  if (!res.ok) return "";

  var data;
  try {
    data = await res.json();
  } catch (e) {
    return "";
  }

  var candidate = data.candidates && data.candidates[0];
  var textParts =
    (candidate &&
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts
        .filter(function (p) {
          return !!p.text;
        })
        .map(function (p) {
          return p.text;
        })) ||
    [];

  var joined = textParts.join("\n").trim();
  if (!joined || joined === OCR_EMPTY_MARKER) return "";
  if (joined.length > OCR_MAX_TEXT_CHARS) {
    joined = joined.slice(0, OCR_MAX_TEXT_CHARS);
  }
  return joined;
}

// اگر فروشنده کلید Gemini وصل کرده و این عکس هنوز OCR نشده، همین الان
// (در پس‌زمینه، بدون تأخیر در تحویل عکس) OCR می‌زند و نتیجه را در KV
// ذخیره می‌کند. مقدار خالی هم یک نتیجه‌ی معتبر است (یعنی آن عکس متنی
// ندارد) و باعث می‌شود دیگر هیچ‌وقت دوباره امتحان نشود. هرگز throw
// نمی‌کند.
async function maybeRunLazyOcr(env, imageUrl, buffer, contentType) {
  try {
    var ocrConfigRaw = await env.CATALOG_KV.get(OCR_CONFIG_KEY);
    if (!ocrConfigRaw) return;

    var ocrConfig;
    try {
      ocrConfig = JSON.parse(ocrConfigRaw);
    } catch (e) {
      return;
    }
    if (!ocrConfig || !ocrConfig.geminiApiKey) return;

    var urlHash = await sha256HexFromString(imageUrl);
    var ocrKey = OCR_TEXT_PREFIX + urlHash;

    var existing = await env.CATALOG_KV.get(ocrKey);
    if (existing !== null) return; // قبلاً یک‌بار محاسبه شده (حتی اگر نتیجه‌اش خالی بوده)

    var base64Data = uint8ToBase64(new Uint8Array(buffer));
    var extractedText = await extractOcrTextFromImageBytes(ocrConfig.geminiApiKey, base64Data, contentType);

    await env.CATALOG_KV.put(
      ocrKey,
      JSON.stringify({ text: extractedText || "", computedAt: Date.now() })
    );
  } catch (e) {
    // بی‌سروصدا نادیده گرفته می‌شود؛ دفعه‌ی بعد که این عکس دوباره دیده
    // شود، دوباره امتحان می‌شود.
  }
}

// نقطه‌ی ورود مسیر GET /img?u=<آدرس عکس روی سایت فروشنده>
async function handleImageProxy(request, env, ctx) {
  var url = new URL(request.url);
  var rawTarget = url.searchParams.get("u");
  if (!rawTarget) {
    return json({ error: "پارامتر u (آدرس عکس) لازم است" }, 400);
  }

  var targetUrl;
  try {
    targetUrl = new URL(rawTarget);
  } catch (e) {
    return json({ error: "آدرس عکس نامعتبر است" }, 400);
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return json({ error: "آدرس عکس نامعتبر است" }, 400);
  }
  if (isPrivateOrDisallowedHost(targetUrl.hostname)) {
    return json({ error: "این آدرس مجاز نیست" }, 400);
  }

  var cache = caches.default;
  var cacheKey = new Request(url.toString(), { method: "GET" });

  var cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, IMG_PROXY_FETCH_TIMEOUT_MS);

  var upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: { "User-Agent": SELF_REFRESH_BOT_UA, Accept: "image/*" },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 0 },
    });
  } catch (e) {
    clearTimeout(timeoutId);
    return json({ error: "دریافت عکس از سایت فروشنده ناموفق بود" }, 502);
  }
  clearTimeout(timeoutId);

  if (!upstream.ok) {
    return json({ error: "سایت فروشنده این عکس را برنگرداند (HTTP " + upstream.status + ")" }, 502);
  }

  var contentType = upstream.headers.get("content-type") || "image/jpeg";
  if (contentType.indexOf("image/") !== 0) {
    return json({ error: "پاسخ سایت فروشنده یک عکس نبود" }, 502);
  }

  var contentLengthHeader = upstream.headers.get("content-length");
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > IMG_MAX_BYTES) {
    return json({ error: "حجم عکس بیش از حد مجاز است" }, 502);
  }

  var buffer;
  try {
    buffer = await upstream.arrayBuffer();
  } catch (e) {
    return json({ error: "خواندن عکس ناموفق بود" }, 502);
  }
  if (!buffer || buffer.byteLength === 0) {
    return json({ error: "عکس خالی بود" }, 502);
  }
  if (buffer.byteLength > IMG_MAX_BYTES) {
    return json({ error: "حجم عکس بیش از حد مجاز است" }, 502);
  }

  var responseToCache = new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=" + IMG_PROXY_CACHE_SECONDS + ", immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
    } catch (e) {}
    try {
      ctx.waitUntil(maybeRunLazyOcr(env, targetUrl.toString(), buffer, contentType));
    } catch (e) {}
  } else {
    // فقط برای اطمینان (در Cloudflare واقعی ctx همیشه موجود است)
    try {
      await cache.put(cacheKey, responseToCache.clone());
    } catch (e) {}
  }

  return responseToCache;
}

// ══════════════════════════════════════════════════════════════════════
// پایان پروکسی عکس
// ══════════════════════════════════════════════════════════════════════

// ‼️ صفحه‌ی landing — کارت گیت‌هابِ قدیمی («۲) اتصال انبار عکس») کاملاً
// حذف شده چون دیگر لازم نیست. کارت OCR که قبلاً «۳» بود، الان «۲» است.
function landingPageHtml() {
  return (
    "<!DOCTYPE html>" +
    '<html lang="fa" dir="rtl"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    "<title>اتصال انبار فروشگاه</title>" +
    "<style>" +
    "body{font-family:Tahoma,Vazirmatn,sans-serif;background:#FAF6ED;margin:0;padding:24px;" +
    "display:flex;align-items:center;justify-content:center;min-height:100vh;box-sizing:border-box;flex-direction:column;}" +
    ".card{background:#fff;border-radius:16px;padding:28px 22px;max-width:420px;width:100%;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center;margin-bottom:18px;}" +
    "h1{font-size:19px;color:#0A3838;margin:0 0 10px;}" +
    "h2{font-size:16px;color:#0A3838;margin:0 0 10px;}" +
    "p{color:#55524A;font-size:14px;line-height:1.7;margin:0 0 20px;}" +
    ".primary-btn{width:100%;padding:16px;font-size:16px;font-weight:800;color:#fff;" +
    "background:#0E4B4B;border:none;border-radius:12px;cursor:pointer;margin-bottom:10px;}" +
    ".primary-btn:disabled{opacity:.55;}" +
    ".fallback-toggle{background:none;border:none;color:#8a7f68;font-size:12.5px;" +
    "text-decoration:underline;cursor:pointer;margin-top:2px;}" +
    "#manualBox{display:none;margin-top:18px;padding-top:18px;border-top:1px solid #E1D9C4;text-align:right;}" +
    "input{width:100%;box-sizing:border-box;padding:14px;font-size:20px;letter-spacing:4px;" +
    "text-align:center;border:2px solid #E1D9C4;border-radius:10px;margin-bottom:14px;" +
    "direction:ltr;text-transform:uppercase;}" +
    "input.wide{font-size:13px;letter-spacing:0;text-transform:none;text-align:left;}" +
    "button.secondary{width:100%;padding:14px;font-size:15px;font-weight:700;color:#0A3838;" +
    "background:#D9A441;border:none;border-radius:10px;cursor:pointer;}" +
    "button:disabled{opacity:.5;}" +
    "#msg{margin-top:16px;font-size:13.5px;min-height:20px;}" +
    "#ocrMsg{margin-top:16px;font-size:13.5px;min-height:20px;text-align:right;}" +
    ".ok{color:#1f5c3a;} .err{color:#8a4b1c;}" +
    ".field-label{display:block;text-align:right;font-size:12.5px;font-weight:700;color:#0A3838;margin:0 0 6px;}" +
    ".help-box{text-align:right;background:#F1EEE4;border-radius:10px;padding:14px 16px;margin-top:14px;" +
    "font-size:12.5px;color:#55524A;line-height:2;}" +
    ".help-box ol{padding-inline-start:20px;margin:6px 0;}" +
    ".status-pill{display:inline-block;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;margin-bottom:12px;}" +
    ".status-pill.on{background:#e4f4ea;color:#1f5c3a;}" +
    ".status-pill.off{background:#fdece0;color:#8a4b1c;}" +
    "</style></head><body>" +
    '<div><div class="card">' +
    "<h1>🔗 اتصال انبار فروشگاه</h1>" +
    "<p>کدی که از سایت دستیار خرید گرفته‌اید همین الان در کلیپ‌بورد گوشی شماست. فقط دکمه‌ی زیر را بزنید.</p>" +
    '<button id="autoBtn" class="primary-btn" onclick="doAutoClaim()">⚡ اتصال خودکار</button>' +
    '<button type="button" class="fallback-toggle" onclick="toggleManual()">کار نکرد؟ کد را دستی وارد کنم</button>' +
    '<div id="manualBox">' +
    '<input id="code" maxlength="6" placeholder="مثلاً A3K9F2">' +
    '<button class="secondary" onclick="doManualClaim()">اتصال دستی</button>' +
    "</div>" +
    '<div id="msg"></div>' +
    "</div>" +

    '<div class="card" style="text-align:right;">' +
    "<h2 style=\"text-align:center;\">🔎 ۲) اتصال کلید خواندن متن روی عکس (اختیاری)</h2>" +
    '<div id="ocrStatusPill" class="status-pill off" style="display:block;text-align:center;">در حال بررسی وضعیت...</div>' +
    "<p>عکس محصولات شما همین الان، خودکار و بدون هیچ تنظیمی، با کیفیت کامل نمایش داده می‌شود. این بخش اختیاری فقط باعث می‌شود دستیار بتواند نوشته‌های ریز روی عکس (مثلاً برچسب یک کرم آرایشی) را هم بخواند. کاملاً رایگان است و به هیچ کارت بانکی نیاز ندارد.</p>" +
    '<label class="field-label">کلید Gemini API</label>' +
    '<input id="geminiKeyInput" class="wide" type="password" placeholder="AIza...">' +
    '<button id="saveOcrConfigBtn" class="secondary" onclick="saveOcrConfig()">💾 ذخیره و تست اتصال</button>' +
    '<button type="button" class="fallback-toggle" onclick="toggleOcrHelp()" style="display:block;margin:10px auto 0;">نمی‌دانم این کلید چیست و از کجا بسازم؟</button>' +
    '<div id="ocrHelpBox" class="help-box" style="display:none;">' +
    "<b>این کلید فقط اجازه می‌دهد ابزار ما یک سرویس رایگان گوگل به اسم Gemini را صدا بزند تا متن روی عکس‌ها را بخواند؛ به هیچ چیز دیگری در حساب گوگل شما دسترسی ندارد.</b>" +
    "<ol>" +
    "<li>در مرورگر گوشی‌تان به آدرس <b>aistudio.google.com</b> بروید.</li>" +
    "<li>با هر حساب Gmail که دارید وارد شوید (نیازی به حساب جدید نیست).</li>" +
    "<li>روی گزینه‌ای شبیه «Get API key» یا «دریافت کلید API» بزنید (معمولاً گوشه‌ی بالا یا سمت چپ صفحه است).</li>" +
    "<li>روی «Create API key» بزنید. اگر از شما پرسید در کدام پروژه ساخته شود، همان گزینه‌ی پیش‌فرض را بزنید.</li>" +
    "<li>یک متن که با <b>AIza</b> شروع می‌شود ساخته می‌شود. روی آیکون کپی کنارش بزنید.</li>" +
    "<li>به همین صفحه برگردید، آن متن کپی‌شده را در کادر «کلید Gemini API» بالا بچسبانید (لمس‌نگه‌دارید روی کادر و «Paste» را بزنید)، سپس روی «ذخیره و تست اتصال» بزنید.</li>" +
    "<li>این کلید در همان «سطح رایگان» گوگل کار می‌کند و هیچ‌جا کارت بانکی از شما خواسته نمی‌شود؛ اگر جایی از شما کارت خواست، آن صفحه را ببندید — آن مرحله برای این کار لازم نیست.</li>" +
    "</ol>" +
    "</div>" +
    '<div id="ocrMsg"></div>' +
    "</div></div>" +
    "<script>" +
    "function toggleManual(){" +
    'var box=document.getElementById("manualBox");' +
    'box.style.display = box.style.display==="block" ? "none" : "block";' +
    "}" +
    "function toggleOcrHelp(){" +
    'var box=document.getElementById("ocrHelpBox");' +
    'box.style.display = box.style.display==="block" ? "none" : "block";' +
    "}" +
    "async function claimWithCode(code){" +
    'var msgEl=document.getElementById("msg");' +
    'if(!code){msgEl.className="err";msgEl.textContent="کدی پیدا نشد. از دکمه‌ی دستی استفاده کنید.";return false;}' +
    'msgEl.className="";msgEl.textContent="در حال اتصال...";' +
    "try{" +
    'var tokRes=await fetch("/internal-token");' +
    "var tokData=await tokRes.json();" +
    "var token=tokData.token;" +
    "var workerBaseUrl=window.location.origin;" +
    'var res=await fetch(' + JSON.stringify(CENTRAL_SERVER_URL) + '+"/claim",{' +
    'method:"POST",headers:{"Content-Type":"application/json"},' +
    "body:JSON.stringify({code:code,workerBaseUrl:workerBaseUrl,updateToken:token})});" +
    "var data=await res.json();" +
    "if(!res.ok){" +
    'msgEl.className="err";msgEl.textContent=data.error||"اتصال ناموفق بود.";' +
    "return false;" +
    "}" +
    'msgEl.className="ok";msgEl.textContent="✅ متصل شد! می‌توانید این صفحه را ببندید و به سایت دستیار خرید برگردید.";' +
    "return true;" +
    "}catch(e){" +
    'msgEl.className="err";msgEl.textContent="اتصال به سرور برقرار نشد. اینترنت را بررسی کنید.";' +
    "return false;" +
    "}" +
    "}" +
    "async function doAutoClaim(){" +
    'var autoBtn=document.getElementById("autoBtn");' +
    'var msgEl=document.getElementById("msg");' +
    "autoBtn.disabled=true;" +
    "var code=null;" +
    "try{" +
    "if(navigator.clipboard && navigator.clipboard.readText){" +
    "var raw=await navigator.clipboard.readText();" +
    'code=(raw||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);' +
    "}" +
    "}catch(clipErr){" +
    "code=null;" +
    "}" +
    "if(!code || code.length<6){" +
    'msgEl.className="err";' +
    'msgEl.textContent="خواندن خودکار کلیپ‌بورد ممکن نشد. روی «کد را دستی وارد کنم» بزنید و کد را paste کنید.";' +
    "autoBtn.disabled=false;" +
    "toggleManual();" +
    "return;" +
    "}" +
    "var ok=await claimWithCode(code);" +
    "if(!ok){autoBtn.disabled=false;toggleManual();}" +
    "}" +
    "async function doManualClaim(){" +
    'var codeEl=document.getElementById("code");' +
    "var code=codeEl.value.trim().toUpperCase();" +
    "var ok=await claimWithCode(code);" +
    "if(!ok){}" +
    "}" +
    "async function refreshOcrStatus(){" +
    'var pill=document.getElementById("ocrStatusPill");' +
    "try{" +
    'var res=await fetch("/ocr-config-status");' +
    "var data=await res.json();" +
    "if(data && data.configured){" +
    'pill.className="status-pill on";' +
    'pill.textContent="✅ متصل — خواندن متن روی عکس فعال است";' +
    "}else{" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز متصل نشده (اختیاری)";' +
    "}" +
    "}catch(e){" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز متصل نشده (اختیاری)";' +
    "}" +
    "}" +
    "async function saveOcrConfig(){" +
    'var keyInput=document.getElementById("geminiKeyInput");' +
    'var btn=document.getElementById("saveOcrConfigBtn");' +
    'var msgEl=document.getElementById("ocrMsg");' +
    "var apiKey=keyInput.value.trim();" +
    "if(!apiKey){" +
    'msgEl.className="err";msgEl.textContent="لطفاً کلید Gemini را وارد کنید.";' +
    "return;" +
    "}" +
    "btn.disabled=true;" +
    'msgEl.className="";msgEl.textContent="در حال تست اتصال به Gemini...";' +
    "try{" +
    'var res=await fetch("/save-ocr-config",{' +
    'method:"POST",headers:{"Content-Type":"application/json"},' +
    "body:JSON.stringify({geminiApiKey:apiKey})});" +
    "var data=await res.json();" +
    "if(!res.ok){" +
    'msgEl.className="err";msgEl.textContent=data.error||"اتصال ناموفق بود.";' +
    "btn.disabled=false;" +
    "return;" +
    "}" +
    'msgEl.className="ok";msgEl.textContent="✅ "+data.message;' +
    "keyInput.value=\"\";" +
    "btn.disabled=false;" +
    "refreshOcrStatus();" +
    "}catch(e){" +
    'msgEl.className="err";msgEl.textContent="اتصال به سرور برقرار نشد. اینترنت را بررسی کنید.";' +
    "btn.disabled=false;" +
    "}" +
    "}" +
    "refreshOcrStatus();" +
    "</script></body></html>"
  );
}

// ══════════════════════════════════════════════════════════════════════
// بخش self-refresh — فقط خزش متن (بدون هیچ منطق عکس/OCR دیگر)
// ══════════════════════════════════════════════════════════════════════

async function selfFetchText(url) {
  var parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isPrivateOrDisallowedHost(parsed.hostname)) return null;

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, SELF_REFRESH_FETCH_TIMEOUT_MS);

  try {
    var res = await fetch(url, {
      headers: { "User-Agent": SELF_REFRESH_BOT_UA, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 0 },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    var text = await res.text();
    if (text.length > SELF_REFRESH_MAX_RESPONSE_CHARS) {
      text = text.slice(0, SELF_REFRESH_MAX_RESPONSE_CHARS);
    }
    return text;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function fetchRobotsDisallowRules(origin) {
  var text = await selfFetchText(origin + "/robots.txt");
  if (!text) return [];

  var lines = text.split("\n").map(function (l) {
    return l.trim();
  });
  var appliesToUs = false;
  var disallowRules = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lower = line.toLowerCase();
    if (lower.indexOf("user-agent:") === 0) {
      var agent = line.split(":")[1] ? line.split(":")[1].trim() : "";
      appliesToUs = agent === "*";
    } else if (appliesToUs && lower.indexOf("disallow:") === 0) {
      var rule = line.split(":")[1] ? line.split(":")[1].trim() : "";
      if (rule) disallowRules.push(rule);
    }
  }

  return disallowRules;
}

function isPathAllowed(disallowRules, path) {
  for (var j = 0; j < disallowRules.length; j++) {
    if (path.indexOf(disallowRules[j]) === 0) return false;
  }
  return true;
}

function extractJsonLdProductsSelf(htmlText, pageUrl) {
  var products = [];
  var regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = regex.exec(htmlText)) !== null) {
    try {
      var data = JSON.parse(match[1]);
      var items = Array.isArray(data) ? data : [data];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var type = item["@type"];
        var isProduct = type === "Product" || (Array.isArray(type) && type.indexOf("Product") !== -1);
        if (isProduct) {
          var offers = item.offers || {};
          if (Array.isArray(offers)) offers = offers[0] || {};
          products.push({
            title: item.name || "",
            price: offers.price || null,
            currency: offers.priceCurrency || null,
            image: Array.isArray(item.image) ? item.image[0] : item.image || "",
            url: item.url || pageUrl,
            in_stock: offers.availability ? String(offers.availability).indexOf("InStock") !== -1 : true,
            source: "json-ld",
          });
        }
      }
    } catch (e) {}
  }
  return products;
}

function extractOgFallbackSelf(htmlText, pageUrl) {
  function meta(prop) {
    var re = new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', "i");
    var m = htmlText.match(re);
    return m ? m[1] : "";
  }
  var title = meta("og:title");
  if (!title) return null;
  var image = meta("og:image");
  var priceAmount = meta("product:price:amount") || meta("og:price:amount");
  var currency = meta("product:price:currency") || meta("og:price:currency");
  return {
    title: title,
    price: priceAmount || null,
    currency: currency || null,
    image: image,
    url: pageUrl,
    in_stock: true,
    source: "opengraph",
  };
}

async function tryDirectProductsApi(url) {
  var text = await selfFetchText(url);
  if (!text) return null;
  try {
    var data = JSON.parse(text);
    var arr = Array.isArray(data) ? data : Array.isArray(data.products) ? data.products : null;
    if (!arr) return null;
    return arr.map(function (item) {
      return {
        title: item.title || item.name || "",
        price: item.price != null ? item.price : null,
        currency: item.currency || null,
        image: item.image || item.imageUrl || "",
        url: item.url || item.buyLink || "",
        in_stock: item.in_stock !== undefined ? !!item.in_stock : true,
        source: "products-api",
      };
    });
  } catch (e) {
    return null;
  }
}

function looksLikeProductUrlSelf(pathname) {
  var lower = pathname.toLowerCase();
  for (var i = 0; i < SELF_REFRESH_PRODUCT_PATH_HINTS.length; i++) {
    if (lower.indexOf(SELF_REFRESH_PRODUCT_PATH_HINTS[i]) !== -1) return true;
  }
  return false;
}

async function findCandidateLinksSelf(origin) {
  var sitemapUrls = [origin + "/sitemap.xml", origin + "/sitemap_index.xml"];
  for (var i = 0; i < sitemapUrls.length; i++) {
    var text = await selfFetchText(sitemapUrls[i]);
    if (text) {
      var locs = [];
      var re = /<loc>([^<]+)<\/loc>/g;
      var m;
      while ((m = re.exec(text)) !== null) locs.push(m[1]);
      if (locs.length) {
        var productLocs = locs.filter(function (u) {
          try {
            return looksLikeProductUrlSelf(new URL(u).pathname);
          } catch (e) {
            return false;
          }
        });
        var pool = productLocs.length ? productLocs : locs;
        return pool.slice(0, SELF_REFRESH_MAX_PAGES);
      }
    }
  }
  return [origin];
}

async function selfCrawl(origin) {
  var links = await findCandidateLinksSelf(origin);
  var disallowRules = await fetchRobotsDisallowRules(origin);
  var products = [];

  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var path = "/";
    try {
      path = new URL(link).pathname;
    } catch (e) {
      continue;
    }

    if (!isPathAllowed(disallowRules, path)) continue;

    var pageHtml = await selfFetchText(link);
    if (!pageHtml) continue;

    var jsonLdItems = extractJsonLdProductsSelf(pageHtml, link);
    if (jsonLdItems.length) {
      products = products.concat(jsonLdItems);
    } else {
      var og = extractOgFallbackSelf(pageHtml, link);
      if (og) products.push(og);
    }

    if (products.length >= SELF_REFRESH_MAX_PRODUCTS) break;
  }

  return products;
}

async function runSelfRefreshCycle(env) {
  try {
    var raw = await env.CATALOG_KV.get(CATALOG_KEY);
    if (!raw) return;

    var current;
    try {
      current = JSON.parse(raw);
    } catch (parseErr) {
      return;
    }

    var origin = current && current.origin ? String(current.origin) : "";
    if (!origin) return;

    var parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch (urlErr) {
      return;
    }
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return;
    if (isPrivateOrDisallowedHost(parsedOrigin.hostname)) return;

    var cleanOrigin = parsedOrigin.origin;

    var directProducts = await tryDirectProductsApi(origin);
    var products = directProducts || (await selfCrawl(cleanOrigin));

    if (!products || !products.length) return;

    await env.CATALOG_KV.put(
      CATALOG_KEY,
      JSON.stringify({
        origin: origin,
        products: products.slice(0, SELF_REFRESH_MAX_PRODUCTS),
        updatedAt: Date.now(),
      })
    );
  } catch (unexpectedErr) {
    // بی‌سروصدا بلعیده می‌شود؛ ساعت بعد دوباره تلاش می‌شود.
  }
}

// ══════════════════════════════════════════════════════════════════════
// پایان بخش self-refresh
// ══════════════════════════════════════════════════════════════════════

// ‼️ جدید — برای هر محصولی که فیلد image دارد و قبلاً حداقل یک‌بار (از
// طریق /img) دیده و OCR شده، متن OCR ذخیره‌شده را در همان محصول ادغام
// می‌کند. هرگز throw نمی‌کند؛ شکست روی یک محصول فقط همان محصول را رد
// می‌کند، نه کل عملیات را.
async function mergeOcrTextIntoProducts(env, products) {
  var list = Array.isArray(products) ? products : [];
  for (var i = 0; i < list.length; i++) {
    var product = list[i];
    if (!product || !product.image) continue;
    try {
      var hash = await sha256HexFromString(product.image);
      var raw = await env.CATALOG_KV.get(OCR_TEXT_PREFIX + hash);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.text === "string" && parsed.text) {
          product.ocr_text = parsed.text;
        }
      }
    } catch (e) {
      // این یک محصول را رد کن، ادامه بده
    }
  }
  return list;
}

// نقطه‌ی ورود GET /catalog — با کش لبه‌ای ۳ دقیقه‌ای تا ادغام ocr_text
// فشار زیادی روی KV نگذارد.
async function handleCatalogRequest(request, env, ctx) {
  var cache = caches.default;

  var cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  var raw = await env.CATALOG_KV.get(CATALOG_KEY);
  var payload;

  if (!raw) {
    payload = { origin: "", products: [], updatedAt: null };
  } else {
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = { origin: "", products: [], updatedAt: null };
    }
    try {
      data.products = await mergeOcrTextIntoProducts(env, data.products || []);
    } catch (mergeErr) {
      // نادیده گرفته می‌شود؛ کاتالوگ بدون ocr_text برگردانده می‌شود
    }
    payload = data;
  }

  var response = json(payload, 200, {
    "Cache-Control": "public, max-age=" + CATALOG_EDGE_CACHE_SECONDS,
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(cache.put(request, response.clone()));
    } catch (e) {}
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(landingPageHtml());
    }

    if (url.pathname === "/internal-token" && request.method === "GET") {
      var tokenForPage = await getOrCreateToken(env);
      return json({ token: tokenForPage });
    }

    if (url.pathname === "/setup" && request.method === "GET") {
      var token = await getOrCreateToken(env);
      return json({
        message:
          "این دو مقدار مخصوص فروشگاه شماست. آن‌ها را با هیچ‌کس به اشتراک نگذارید.",
        workerBaseUrl: url.origin,
        updateToken: token,
      });
    }

    if (url.pathname === "/update" && request.method === "POST") {
      var auth = request.headers.get("Authorization") || "";
      var validToken = await getOrCreateToken(env);
      if (auth !== "Bearer " + validToken) {
        return json({ error: "توکن نامعتبر است" }, 401);
      }
      var body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "بدنه‌ی درخواست نامعتبر است" }, 400);
      }
      if (!body || !Array.isArray(body.products)) {
        return json({ error: "products باید یک آرایه باشد" }, 400);
      }
      await env.CATALOG_KV.put(
        CATALOG_KEY,
        JSON.stringify({
          origin: body.origin || "",
          products: body.products,
          updatedAt: Date.now(),
        })
      );
      return json({ ok: true, productCount: body.products.length });
    }

    if (url.pathname === "/catalog" && request.method === "GET") {
      return handleCatalogRequest(request, env, ctx);
    }

    if (url.pathname === "/img" && request.method === "GET") {
      return handleImageProxy(request, env, ctx);
    }

    if (url.pathname === "/save-ocr-config" && request.method === "POST") {
      return handleSaveOcrConfig(request, env);
    }
    if (url.pathname === "/ocr-config-status" && request.method === "GET") {
      return handleOcrConfigStatus(env);
    }

    return json({ error: "مسیر یافت نشد" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSelfRefreshCycle(env));
  },
};
