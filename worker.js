/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ این نسخه، بخش‌های ۲ و ۳ و ۴ معماری فدرال را پیاده می‌کند:
 *
 *  بخش ۲ — بازنویسی کامل خزش (runSelfRefreshCycle و توابع کمکی‌اش):
 *    به‌جای نوشتن حداکثر ۲۰۰ محصول در KV، حالا محصولات به‌صورت صفحه‌بندی‌شده
 *    و ازسرگیری‌پذیر (resumable) مستقیماً در جدول products دیتابیس D1
 *    نوشته می‌شوند. وضعیتِ ازسرگیری (کدام sitemap، کدام آفست) در جدول
 *    crawl_state نگه داشته می‌شود؛ هر بار که چرخه‌ی ساعتی اجرا شود، دقیقاً
 *    از همان‌جایی که دفعه‌ی قبل متوقف شده بود ادامه می‌دهد.
 *
 *  بخش ۳ — /catalog (خواندن از D1) + /search جدید (FTS5 روی D1):
 *
 *  بخش ۴ — لایه‌ی جست‌وجوی معنایی Vectorize:
 *    بردار هر محصول (عنوان + متن OCR) به‌صورت تدریجی در scheduled() ساخته
 *    و در Vectorize ذخیره می‌شود. /search اول از Vectorize استفاده می‌کند؛
 *    اگر Vectorize بایند نشده باشد یا جواب نداد، خودکار و بی‌صدا به همان
 *    جست‌وجوی کلمه‌ای FTS5 سقوط می‌کند — هرگز خطا نمی‌دهد.
 *    ‼️ چون Cloudflare راهی برای ساخت خودکار Vectorize (شبیه KV/D1) ندارد،
 *    یک مسیر جدید /setup-vectorize و یک کارت تازه در صفحه‌ی landing اضافه
 *    شده که با یک توکن API (نه خط‌فرمان)، ایندکس Vectorize را برای شما
 *    می‌سازد. تا وقتی این مرحله را انجام ندهید، همه‌چیز دقیقاً مثل قبل
 *    (فقط با FTS5) کار می‌کند — هیچ‌چیز خراب نمی‌شود.
 *
 * هیچ منطق دیگری (مسیرهای /، /internal-token، /setup، /update، پروکسی
 * /img، OCR تنبل، دکمه‌ی «اتصال خودکار») تغییر نکرده است.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";
const OCR_CONFIG_KEY = "ocr-config";
const OCR_TEXT_PREFIX = "ocr:";
const VECTORIZE_CONFIG_KEY = "vectorize-config"; // ‼️ جدید (بخش ۴)

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
const CENTRAL_SERVER_URL = "https://shop-assistant.laana9258.workers.dev";

// تنظیمات مخصوص چرخه‌ی خودکار ساعتی (self-refresh).
const SELF_REFRESH_BOT_UA =
  "SA-ShopSelfRefresh/1.0 (+https://ai-assistant-cpl.pages.dev/bot-info)";
const SELF_REFRESH_FETCH_TIMEOUT_MS = 10000;
const SELF_REFRESH_MAX_RESPONSE_CHARS = 900000;
const SELF_REFRESH_MAX_PAGES = 18; // حداکثر صفحه‌ی محصول در هر یک اجرای چرخه (هر ساعت)
const SELF_REFRESH_PRODUCT_PATH_HINTS = ["/product", "/products", "/shop/", "/item/", "/p/"];
// ‼️ جدید (بخش ۲) — بعد از اینکه یک دور کامل خزش کل سایت تمام شد (phase=done)،
// این‌قدر صبر می‌کنیم قبل از اینکه یک دور کامل تازه را از نو شروع کنیم؛
// این‌طور به سایت فروشنده فشار مداوم و غیرضروری وارد نمی‌شود.
const SELF_REFRESH_FULL_CYCLE_COOLDOWN_MS = 20 * 60 * 60 * 1000; // ۲۰ ساعت

// تنظیمات مخصوص اعتبارسنجی کلید Gemini (برای کارت OCR در landing).
const GENERIC_VALIDATE_TIMEOUT_MS = 10000;

// تنظیمات مخصوص پروکسی عکس (Cache API لبه‌ای Cloudflare).
const IMG_PROXY_FETCH_TIMEOUT_MS = 15000;
const IMG_MAX_BYTES = 15 * 1024 * 1024; // سقف ۱۵ مگابایت برای هر عکس؛ فقط برای جلوگیری از سوءاستفاده
const IMG_PROXY_CACHE_SECONDS = 60 * 60 * 24 * 365; // یک سال

// تنظیمات مخصوص OCR تنبل (اجرا در لحظه‌ی اولین دیدن هر عکس).
const OCR_GEMINI_MODEL = "gemini-3.1-flash-lite"; // همان مدلی که app.js برای چت هم استفاده می‌کند
const OCR_GEMINI_TIMEOUT_MS = 12000;
const OCR_MAX_TEXT_CHARS = 2000;
const OCR_EMPTY_MARKER = "(بدون متن)";

// کش لبه‌ای پاسخ /catalog، تا کوئری‌های D1 فشار زیادی به دیتابیس نزنند.
const CATALOG_EDGE_CACHE_SECONDS = 180; // ۳ دقیقه

// ‼️ جدید (بخش ۳) — تنظیمات مسیر /catalog (خواندن صفحه‌بندی‌شده از D1).
const CATALOG_DEFAULT_LIMIT = 5000;
const CATALOG_MAX_LIMIT = 20000;

// ‼️ جدید (بخش ۳) — تنظیمات مسیر /search (طبق معماری: حداکثر ۱۰ کاندید).
const SEARCH_MAX_CANDIDATES = 10;

// ‼️ جدید (بخش ۴) — تنظیمات مدل embedding و Vectorize.
// از همان کلید Gemini که برای OCR وصل شده استفاده می‌کنیم (کارت «۲»)؛
// نیازی به کلید دومی نیست. مدل embedContent گوگل، بردار ۷۶۸ بعدی می‌دهد.
const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_TIMEOUT_MS = 12000;
const VECTOR_EMBED_BATCH_SIZE = 20; // تعداد محصولی که هر بار اجرای scheduled() امبد می‌شود
const VECTOR_EMBED_TEXT_MAX_CHARS = 800;
const VECTORIZE_API_TIMEOUT_MS = 15000;

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
// پیکربندی کلید Gemini برای OCR (کارت «۲» در صفحه‌ی landing) — بدون تغییر
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
// پروکسی عکس با کش لبه‌ای Cloudflare + OCR تنبل — بدون تغییر
// ══════════════════════════════════════════════════════════════════════

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
    if (existing !== null) return;

    var base64Data = uint8ToBase64(new Uint8Array(buffer));
    var extractedText = await extractOcrTextFromImageBytes(ocrConfig.geminiApiKey, base64Data, contentType);

    await env.CATALOG_KV.put(
      ocrKey,
      JSON.stringify({ text: extractedText || "", computedAt: Date.now() })
    );
  } catch (e) {
    // بی‌سروصدا نادیده گرفته می‌شود
  }
}

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
    try {
      await cache.put(cacheKey, responseToCache.clone());
    } catch (e) {}
  }

  return responseToCache;
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ جدید (بخش ۴) — راه‌اندازی Vectorize از طریق توکن API (بدون خط‌فرمان)
// ══════════════════════════════════════════════════════════════════════

// یک نام یکتا و مجاز برای ایندکس Vectorize می‌سازد (فقط حروف کوچک لاتین،
// عدد، خط‌تیره؛ کمتر از ۳۲ کاراکتر؛ با حرف شروع می‌شود).
function buildVectorizeIndexName(workerOrigin) {
  var base = "shop-vec";
  try {
    var host = new URL(workerOrigin).hostname.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (host) base = "shop-vec-" + host.slice(0, 16);
  } catch (e) {}
  return base.slice(0, 31);
}

// از REST API خودِ Cloudflare (نه wrangler) برای ساخت ایندکس Vectorize
// استفاده می‌کند. هرگز throw نمی‌کند؛ همیشه { ok, ... } برمی‌گرداند.
async function createVectorizeIndexViaApi(accountId, apiToken, indexName) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, VECTORIZE_API_TIMEOUT_MS);

  try {
    var res = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(accountId) + "/vectorize/v2/indexes",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: indexName,
          description: "ایندکس جست‌وجوی معنایی محصولات فروشگاه",
          config: { dimensions: EMBEDDING_DIMENSIONS, metric: "cosine" },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    var data = null;
    try {
      data = await res.json();
    } catch (e) {}

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "این توکن API اجازه‌ی کافی ندارد. مطمئن شوید هنگام ساخت توکن، دسترسی «Vectorize - Edit» را انتخاب کرده‌اید." };
    }

    // اگر قبلاً همین ایندکس ساخته شده، آن را یک موفقیت در نظر بگیر (نه خطا)
    var alreadyExists =
      data &&
      data.errors &&
      data.errors.some(function (e) {
        return String(e.message || "").toLowerCase().indexOf("already exists") !== -1;
      });

    if (!res.ok && !alreadyExists) {
      var errMsg = (data && data.errors && data.errors[0] && data.errors[0].message) || "خطای نامشخص از Cloudflare API (HTTP " + res.status + ")";
      return { ok: false, error: errMsg };
    }

    return { ok: true, indexName: indexName, alreadyExisted: !!alreadyExists };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: "اتصال به Cloudflare API برقرار نشد. اینترنت را بررسی کنید و دوباره تلاش کنید." };
  }
}

async function handleSetupVectorize(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "بدنه‌ی درخواست نامعتبر است" }, 400);
  }
  if (!body || !body.accountId || !body.apiToken) {
    return json({ error: "شناسه‌ی حساب (Account ID) و توکن API هر دو لازم هستند" }, 400);
  }

  var accountId = String(body.accountId).trim();
  var apiToken = String(body.apiToken).trim();
  if (!accountId || !apiToken) {
    return json({ error: "شناسه‌ی حساب و توکن نمی‌توانند خالی باشند" }, 400);
  }

  var workerOrigin = new URL(request.url).origin;
  var indexName = buildVectorizeIndexName(workerOrigin);

  var result = await createVectorizeIndexViaApi(accountId, apiToken, indexName);
  if (!result.ok) {
    return json({ error: result.error }, 400);
  }

  await env.CATALOG_KV.put(
    VECTORIZE_CONFIG_KEY,
    JSON.stringify({
      accountId: accountId,
      apiToken: apiToken,
      indexName: result.indexName,
      indexCreatedAt: Date.now(),
      indexReadyForBinding: true,
    })
  );

  return json({
    ok: true,
    indexName: result.indexName,
    alreadyExisted: result.alreadyExisted,
    nextStepToml:
      "[[vectorize]]\nbinding = \"VECTOR_INDEX\"\nindex_name = \"" + result.indexName + "\"",
    message: result.alreadyExisted
      ? "این ایندکس از قبل وجود داشت؛ آماده‌ی اتصال است."
      : "ایندکس با موفقیت ساخته شد؛ آماده‌ی اتصال است.",
  });
}

async function handleVectorizeStatus(env) {
  var raw = await env.CATALOG_KV.get(VECTORIZE_CONFIG_KEY);
  var boundLive = !!env.VECTOR_INDEX;
  if (!raw) {
    return json({ indexCreated: false, boundLive: boundLive });
  }
  var cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return json({ indexCreated: false, boundLive: boundLive });
  }
  var embedRow = null;
  try {
    embedRow = await env.CATALOG_DB.prepare("SELECT total_embedded, last_run_at, last_error FROM embed_state WHERE id = 1").first();
  } catch (e) {}
  return json({
    indexCreated: true,
    indexName: cfg.indexName,
    boundLive: boundLive,
    totalEmbedded: (embedRow && embedRow.total_embedded) || 0,
    lastEmbedRunAt: (embedRow && embedRow.last_run_at) || null,
    lastEmbedError: (embedRow && embedRow.last_error) || null,
  });
}

// ══════════════════════════════════════════════════════════════════════
// صفحه‌ی landing — کارت سوم (Vectorize) اضافه شده
// ══════════════════════════════════════════════════════════════════════

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
    "#vecMsg{margin-top:16px;font-size:13.5px;min-height:20px;text-align:right;}" +
    ".ok{color:#1f5c3a;} .err{color:#8a4b1c;}" +
    ".field-label{display:block;text-align:right;font-size:12.5px;font-weight:700;color:#0A3838;margin:0 0 6px;}" +
    ".help-box{text-align:right;background:#F1EEE4;border-radius:10px;padding:14px 16px;margin-top:14px;" +
    "font-size:12.5px;color:#55524A;line-height:2;}" +
    ".help-box ol{padding-inline-start:20px;margin:6px 0;}" +
    ".status-pill{display:inline-block;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;margin-bottom:12px;}" +
    ".status-pill.on{background:#e4f4ea;color:#1f5c3a;}" +
    ".status-pill.off{background:#fdece0;color:#8a4b1c;}" +
    ".toml-box{direction:ltr;text-align:left;background:#1c1a17;color:#d8f0e6;border-radius:10px;" +
    "padding:12px 14px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;margin-top:10px;}" +
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
    "<li>روی گزینه‌ای شبیه «Get API key» یا «دریافت کلید API» بزنید.</li>" +
    "<li>روی «Create API key» بزنید.</li>" +
    "<li>یک متن که با <b>AIza</b> شروع می‌شود ساخته می‌شود. روی آیکون کپی کنارش بزنید.</li>" +
    "<li>به همین صفحه برگردید و آن را در کادر بالا paste کنید، سپس «ذخیره و تست اتصال» را بزنید.</li>" +
    "</ol>" +
    "</div>" +
    '<div id="ocrMsg"></div>' +
    "</div>" +

    '<div class="card" style="text-align:right;">' +
    "<h2 style=\"text-align:center;\">🧠 ۳) فعال‌سازی جست‌وجوی معنایی هوشمند (اختیاری، پیشرفته)</h2>" +
    '<div id="vecStatusPill" class="status-pill off" style="display:block;text-align:center;">در حال بررسی وضعیت...</div>' +
    "<p>این بخش باعث می‌شود دستیار، معنیِ سوال کاربر را بفهمد (نه فقط کلمه‌به‌کلمه)، حتی وقتی فروشگاه شما میلیون‌ها محصول داشته باشد. کاملاً اختیاری است؛ بدون این کارت هم جست‌وجوی کلمه‌ای عادی همیشه کار می‌کند. برای فعال‌سازی، به یک «توکن API» از حساب Cloudflare خودتان نیاز دارید (نه کلید‌های بالا).</p>" +
    '<label class="field-label">شناسه‌ی حساب Cloudflare (Account ID)</label>' +
    '<input id="cfAccountIdInput" class="wide" type="text" placeholder="یک رشته‌ی ۳۲ کاراکتری">' +
    '<label class="field-label">توکن API Cloudflare</label>' +
    '<input id="cfApiTokenInput" class="wide" type="password" placeholder="با دسترسی Vectorize - Edit">' +
    '<button id="setupVectorizeBtn" class="secondary" onclick="setupVectorize()">🧠 ساخت ایندکس جست‌وجوی معنایی</button>' +
    '<button type="button" class="fallback-toggle" onclick="toggleVecHelp()" style="display:block;margin:10px auto 0;">نمی‌دانم این‌ها را از کجا پیدا کنم؟</button>' +
    '<div id="vecHelpBox" class="help-box" style="display:none;">' +
    "<b>هر دوی این مقادیر را می‌سازید بدون نیاز به خط‌فرمان، فقط با چند لمس در همین مرورگر:</b>" +
    "<ol>" +
    "<li>در همین گوشی، به آدرس <b>dash.cloudflare.com</b> بروید و با حسابی که برای دکمه‌ی «Deploy» بالا استفاده کردید وارد شوید.</li>" +
    "<li><b>شناسه‌ی حساب (Account ID):</b> در همان صفحه‌ی اول داشبورد، در ستون سمت راست/پایین صفحه، «Account ID» نوشته شده — روی آن لمس کنید تا کپی شود.</li>" +
    "<li><b>ساخت توکن API:</b> روی آیکون پروفایل بالای صفحه بزنید ← «My Profile» ← تب «API Tokens» ← دکمه‌ی «Create Token».</li>" +
    "<li>پایین صفحه گزینه‌ی «Create Custom Token» را انتخاب کنید.</li>" +
    "<li>یک اسم دلخواه بدهید (مثلاً my-shop-vectorize). در بخش «Permissions»، از منوی اول <b>Account</b> را انتخاب کنید، از منوی دوم <b>Vectorize</b>، و از منوی سوم <b>Edit</b>.</li>" +
    "<li>در بخش «Account Resources» پایین‌تر، حساب خودتان را انتخاب کنید.</li>" +
    "<li>پایین صفحه «Continue to summary» و بعد «Create Token» را بزنید.</li>" +
    "<li>یک رشته‌ی طولانی به شما نشان داده می‌شود — این توکن است؛ روی «Copy» بزنید و همان‌جا در کادر بالا paste کنید. (این صفحه فقط یک‌بار این توکن را نشان می‌دهد؛ اگر بستید، باید یک توکن تازه بسازید.)</li>" +
    "</ol>" +
    "</div>" +
    '<div id="vecMsg"></div>' +
    '<div id="vecTomlBox" style="display:none;">' +
    '<p style="margin-top:16px;">✅ ایندکس ساخته شد! یک قدم آخر مانده (این یکی را باید خودتان، یک‌بار، در گیت‌هاب انجام دهید):</p>' +
    "<ol>" +
    "<li>وارد ریپازیتوری <b>shop-catalog-template</b> خودتان در گیت‌هاب شوید.</li>" +
    "<li>فایل <b>wrangler.toml</b> را باز کنید و روی آیکون مداد (ویرایش) بزنید.</li>" +
    "<li>دقیقاً همین چند خط را به انتهای فایل اضافه کنید (کپی‌شان کنید):</li>" +
    "</ol>" +
    '<pre id="vecTomlSnippet" class="toml-box"></pre>' +
    "<ol start=\"4\">" +
    "<li>پایین صفحه‌ی گیت‌هاب، «Commit changes» را بزنید.</li>" +
    "<li>اگر ریپازیتوری‌تان به‌صورت خودکار به Cloudflare وصل است (همان چیزی که دکمه‌ی Deploy اولیه ساخت)، همین کامیت به‌تنهایی دیپلوی تازه را شروع می‌کند — چیز دیگری لازم نیست.</li>" +
    "</ol>" +
    "</div>" +
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
    "function toggleVecHelp(){" +
    'var box=document.getElementById("vecHelpBox");' +
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
    "async function refreshVecStatus(){" +
    'var pill=document.getElementById("vecStatusPill");' +
    "try{" +
    'var res=await fetch("/vectorize-status");' +
    "var data=await res.json();" +
    "if(data && data.boundLive){" +
    'pill.className="status-pill on";' +
    'pill.textContent="✅ فعال و متصل — جست‌وجوی معنایی کار می‌کند";' +
    "}else if(data && data.indexCreated){" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ ایندکس ساخته شده؛ منتظر آخرین قدم دستی (wrangler.toml)";' +
    "}else{" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز فعال نشده (اختیاری)";' +
    "}" +
    "}catch(e){" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز فعال نشده (اختیاری)";' +
    "}" +
    "}" +
    "async function setupVectorize(){" +
    'var accInput=document.getElementById("cfAccountIdInput");' +
    'var tokInput=document.getElementById("cfApiTokenInput");' +
    'var btn=document.getElementById("setupVectorizeBtn");' +
    'var msgEl=document.getElementById("vecMsg");' +
    'var tomlBox=document.getElementById("vecTomlBox");' +
    'var tomlSnippet=document.getElementById("vecTomlSnippet");' +
    "var accountId=accInput.value.trim();" +
    "var apiToken=tokInput.value.trim();" +
    "if(!accountId || !apiToken){" +
    'msgEl.className="err";msgEl.textContent="هر دو مقدار لازم است.";' +
    "return;" +
    "}" +
    "btn.disabled=true;" +
    'msgEl.className="";msgEl.textContent="در حال ساخت ایندکس جست‌وجوی معنایی...";' +
    "try{" +
    'var res=await fetch("/setup-vectorize",{' +
    'method:"POST",headers:{"Content-Type":"application/json"},' +
    "body:JSON.stringify({accountId:accountId,apiToken:apiToken})});" +
    "var data=await res.json();" +
    "if(!res.ok){" +
    'msgEl.className="err";msgEl.textContent=data.error||"ساخت ایندکس ناموفق بود.";' +
    "btn.disabled=false;" +
    "return;" +
    "}" +
    'msgEl.className="ok";msgEl.textContent="✅ "+data.message;' +
    "tomlSnippet.textContent=data.nextStepToml;" +
    'tomlBox.style.display="block";' +
    "tokInput.value=\"\";" +
    "btn.disabled=false;" +
    "refreshVecStatus();" +
    "}catch(e){" +
    'msgEl.className="err";msgEl.textContent="اتصال به سرور برقرار نشد. اینترنت را بررسی کنید.";' +
    "btn.disabled=false;" +
    "}" +
    "}" +
    "refreshOcrStatus();" +
    "refreshVecStatus();" +
    "</script></body></html>"
  );
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش ۲ — خزش تدریجی، صفحه‌بندی‌شده و ازسرگیری‌پذیر، مستقیم در D1
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

// ‼️ جدید — به‌جای برگرداندنِ لیستِ محدودِ لینک‌های محصول (که در نسخه‌ی
// قبلی مستقیم به ۱۸ تا بریده می‌شد)، حالا فقط «برگ‌های sitemap» (خودِ
// فایل‌های sitemap.xml حاوی <loc>) را برمی‌گرداند — این آرایه معمولاً
// چند ده تایی است، نه میلیونی، پس ذخیره‌اش در D1 مشکلی ندارد. فهرستِ
// واقعیِ لینک‌های محصول از داخل هر برگ، در لحظه‌ی نیاز (در
// continueCrawlPageD1) خوانده می‌شود.
async function discoverLeafSitemapsD1(origin) {
  var candidates = [origin + "/sitemap_index.xml", origin + "/sitemap.xml"];
  for (var i = 0; i < candidates.length; i++) {
    var text = await selfFetchText(candidates[i]);
    if (!text) continue;

    if (/<sitemapindex/i.test(text)) {
      var subLocs = [];
      var re = /<loc>([^<]+)<\/loc>/g;
      var m;
      while ((m = re.exec(text)) !== null) subLocs.push(m[1]);
      if (subLocs.length) return subLocs;
    } else if (/<urlset/i.test(text) || /<loc>/i.test(text)) {
      // خودِ همین فایل، یک sitemap برگ است (لیست مستقیم لینک‌ها)
      return [candidates[i]];
    }
  }
  return []; // هیچ sitemap ای پیدا نشد
}

async function getCrawlStateD1(env) {
  var row = await env.CATALOG_DB.prepare("SELECT * FROM crawl_state WHERE id = 1").first();
  if (!row) {
    // فقط برای اطمینان؛ migration بخش ۱ همین الان این ردیف را ساخته بود
    await env.CATALOG_DB.prepare(
      "INSERT OR IGNORE INTO crawl_state (id, phase, sitemap_urls, next_index, total_found, total_crawled) VALUES (1, 'idle', '{}', 0, 0, 0)"
    ).run();
    row = await env.CATALOG_DB.prepare("SELECT * FROM crawl_state WHERE id = 1").first();
  }
  return row;
}

async function saveCrawlStateD1(env, patch) {
  var sets = [];
  var values = [];
  for (var k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    sets.push(k + " = ?");
    values.push(patch[k]);
  }
  if (!sets.length) return;
  values.push(1);
  var stmt = env.CATALOG_DB.prepare("UPDATE crawl_state SET " + sets.join(", ") + " WHERE id = ?");
  await stmt.bind.apply(stmt, values).run();
}

// چند محصول را یک‌جا (batch) در D1 upsert می‌کند. اگر محصولی url نداشته
// باشد، یک شناسه‌ی تصادفی موقت برایش می‌سازیم تا محدودیت UNIQUE(url)
// خراب نشود؛ در عمل استخراج JSON-LD/OG همیشه یک url (حداقل همان آدرس
// صفحه) می‌گذارد، پس این حالت نادر است.
async function upsertProductsBatchD1(env, products) {
  var list = Array.isArray(products) ? products : [];
  if (!list.length) return;
  var now = Date.now();

  var stmts = list.map(function (p) {
    var productUrl = p && p.url ? String(p.url) : "no-url:" + crypto.randomUUID();
    return env.CATALOG_DB
      .prepare(
        "INSERT INTO products (url, title, price, currency, image, in_stock, source, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(url) DO UPDATE SET title=excluded.title, price=excluded.price, currency=excluded.currency, " +
          "image=excluded.image, in_stock=excluded.in_stock, source=excluded.source, updated_at=excluded.updated_at"
      )
      .bind(
        productUrl,
        (p && p.title) || "",
        p && p.price != null ? String(p.price) : null,
        (p && p.currency) || null,
        (p && p.image) || "",
        p && p.in_stock ? 1 : 0,
        (p && p.source) || null,
        now
      );
  });

  try {
    await env.CATALOG_DB.batch(stmts);
  } catch (batchErr) {
    // اگر batch یک‌جا خطا داد (مثلاً یک محصول ساختار عجیبی داشت)، تک‌تک
    // امتحان می‌کنیم تا فقط همان یکی رد شود، نه کل دسته.
    for (var i = 0; i < stmts.length; i++) {
      try {
        await stmts[i].run();
      } catch (singleErr) {}
    }
  }
}

// اگر D1 هنوز خالی است ولی از تأیید اولیه (register/verify در
// shop-assistant مرکزی) یک کاتالوگ کوچک در KV باقی مانده، همان را یک‌بار
// در D1 seed می‌کند — تا بلافاصله بعد از اتصال، /catalog و /search خالی
// نباشند و منتظر اولین اجرای ساعتی self-refresh نمانند.
async function bootstrapFromLegacyKvIfEmpty(env) {
  try {
    var countRow = await env.CATALOG_DB.prepare("SELECT COUNT(*) AS c FROM products").first();
    if (countRow && countRow.c > 0) return;

    var raw = await env.CATALOG_KV.get(CATALOG_KEY);
    if (!raw) return;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!data || !Array.isArray(data.products) || !data.products.length) return;

    await upsertProductsBatchD1(env, data.products);
  } catch (e) {}
}

async function getShopOriginFromKv(env) {
  try {
    var raw = await env.CATALOG_KV.get(CATALOG_KEY);
    if (!raw) return "";
    var data = JSON.parse(raw);
    return (data && data.origin) || "";
  } catch (e) {
    return "";
  }
}

// یک بخش از کار خزش را انجام می‌دهد: حداکثر SELF_REFRESH_MAX_PAGES صفحه‌ی
// محصول را از دقیقاً همان‌جایی که دفعه‌ی قبل متوقف شده بود می‌خواند و در
// D1 می‌نویسد، و وضعیت (leafIndex/urlOffset) را برای اجرای بعدی ذخیره
// می‌کند. اگر به انتهای همه‌ی برگ‌های sitemap برسد، phase را 'done'
// می‌کند تا اجرای بعدی، بعد از کول‌داون، یک دور تازه شروع کند.
async function continueCrawlPageD1(env, origin, stateRow) {
  var stateData;
  try {
    stateData = JSON.parse(stateRow.sitemap_urls || "{}");
  } catch (e) {
    stateData = {};
  }
  var leaves = Array.isArray(stateData.leaves) ? stateData.leaves : [];
  var leafIndex = stateData.leafIndex || 0;
  var urlOffset = stateData.urlOffset || 0;

  var disallowRules = await fetchRobotsDisallowRules(origin);

  var totalCrawled = stateRow.total_crawled || 0;
  var totalFound = stateRow.total_found || 0;

  // اگر اصلاً sitemap ای پیدا نشد → فقط خودِ صفحه‌ی اصلی را یک‌بار
  // پردازش کن و همان‌جا phase را done کن (دقیقاً رفتار پشتیبانِ قبلی).
  if (!leaves.length) {
    var path = "/";
    try {
      path = new URL(origin).pathname;
    } catch (e) {}
    if (isPathAllowed(disallowRules, path)) {
      var pageHtml = await selfFetchText(origin);
      if (pageHtml) {
        var items = extractJsonLdProductsSelf(pageHtml, origin);
        if (!items.length) {
          var og = extractOgFallbackSelf(pageHtml, origin);
          if (og) items = [og];
        }
        if (items.length) {
          await upsertProductsBatchD1(env, items);
          totalCrawled += items.length;
        }
      }
    }
    await saveCrawlStateD1(env, {
      phase: "done",
      total_crawled: totalCrawled,
      last_run_at: Date.now(),
      last_error: null,
    });
    return;
  }

  var pagesProcessedThisRun = 0;

  while (pagesProcessedThisRun < SELF_REFRESH_MAX_PAGES && leafIndex < leaves.length) {
    var leafUrl = leaves[leafIndex];
    var leafText = await selfFetchText(leafUrl);

    if (!leafText) {
      // این برگ خراب/در دسترس‌نبود؛ رد شو و برو سراغ برگ بعدی
      leafIndex++;
      urlOffset = 0;
      continue;
    }

    var productUrls = [];
    var re = /<loc>([^<]+)<\/loc>/g;
    var m;
    while ((m = re.exec(leafText)) !== null) productUrls.push(m[1]);

    if (urlOffset === 0) {
      totalFound += productUrls.length;
    }

    var batchItems = [];

    while (urlOffset < productUrls.length && pagesProcessedThisRun < SELF_REFRESH_MAX_PAGES) {
      var link = productUrls[urlOffset];
      urlOffset++;
      pagesProcessedThisRun++;

      var linkPath = "/";
      try {
        linkPath = new URL(link).pathname;
      } catch (e) {
        continue;
      }
      if (!isPathAllowed(disallowRules, linkPath)) continue;

      var linkHtml = await selfFetchText(link);
      if (!linkHtml) continue;

      var jsonLdItems = extractJsonLdProductsSelf(linkHtml, link);
      if (jsonLdItems.length) {
        batchItems = batchItems.concat(jsonLdItems);
      } else {
        var ogItem = extractOgFallbackSelf(linkHtml, link);
        if (ogItem) batchItems.push(ogItem);
      }
    }

    if (batchItems.length) {
      await upsertProductsBatchD1(env, batchItems);
      totalCrawled += batchItems.length;
    }

    if (urlOffset >= productUrls.length) {
      leafIndex++;
      urlOffset = 0;
    }
  }

  var isDone = leafIndex >= leaves.length;

  await saveCrawlStateD1(env, {
    phase: isDone ? "done" : "crawling",
    sitemap_urls: JSON.stringify({ leaves: leaves, leafIndex: leafIndex, urlOffset: urlOffset }),
    total_found: totalFound,
    total_crawled: totalCrawled,
    last_run_at: Date.now(),
    last_error: null,
  });
}

// نقطه‌ی ورود چرخه‌ی ساعتی — نامش نسبت به نسخه‌ی قبلی عوض نشده (هنوز هم
// runSelfRefreshCycle نام دارد) چون scheduled() پایین‌تر همین نام را
// صدا می‌زند؛ فقط بدنه‌اش کاملاً برای نوشتن در D1 بازنویسی شده.
async function runSelfRefreshCycle(env) {
  try {
    var origin = await getShopOriginFromKv(env);
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

    await bootstrapFromLegacyKvIfEmpty(env);

    var state = await getCrawlStateD1(env);

    if (state.phase === "done") {
      var elapsedSinceLastRun = Date.now() - (state.last_run_at || 0);
      if (elapsedSinceLastRun < SELF_REFRESH_FULL_CYCLE_COOLDOWN_MS) {
        return; // دور کامل قبلی هنوز «تازه» است؛ فعلاً کاری نکن
      }
    }

    if (state.phase === "idle" || state.phase === "done") {
      // ابتدا یک تلاش سریع برای API مستقیم محصولات (اگر فروشگاه چنین
      // چیزی داشته باشد، خیلی سریع‌تر و دقیق‌تر از خزش صفحه‌به‌صفحه است)
      var direct = await tryDirectProductsApi(cleanOrigin);
      if (direct && direct.length) {
        await upsertProductsBatchD1(env, direct);
        await saveCrawlStateD1(env, {
          phase: "done",
          sitemap_urls: "{}",
          total_found: direct.length,
          total_crawled: direct.length,
          last_run_at: Date.now(),
          last_error: null,
        });
        return;
      }

      // در غیر این صورت، sitemap را کشف کن و یک دور تازه‌ی خزشِ
      // صفحه‌بندی‌شده را شروع کن
      var leaves = await discoverLeafSitemapsD1(cleanOrigin);
      await saveCrawlStateD1(env, {
        phase: "crawling",
        sitemap_urls: JSON.stringify({ leaves: leaves, leafIndex: 0, urlOffset: 0 }),
        total_found: 0,
        total_crawled: 0,
        last_run_at: Date.now(),
        last_error: null,
      });
      state = await getCrawlStateD1(env);
    }

    if (state.phase === "crawling") {
      await continueCrawlPageD1(env, cleanOrigin, state);
    }
  } catch (unexpectedErr) {
    try {
      await saveCrawlStateD1(env, {
        last_error: String((unexpectedErr && unexpectedErr.message) || unexpectedErr),
        last_run_at: Date.now(),
      });
    } catch (e2) {}
  }
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش ۳ — /catalog (از D1) + /search (FTS5، با ادغام Vectorize در بخش ۴)
// ══════════════════════════════════════════════════════════════════════

// ردیف خام D1 را به همان ساختار محصولی که app.js/widget.js انتظار
// دارند تبدیل می‌کند (title, price, currency, image, url, in_stock,
// ocr_text, source).
function dbRowToProduct(r) {
  var out = {
    url: r.url || "",
    title: r.title || "",
    price: r.price,
    currency: r.currency,
    image: r.image || "",
    in_stock: !!r.in_stock,
    source: r.source,
  };
  if (r.ocr_text) out.ocr_text = r.ocr_text;
  return out;
}

// برای هر محصولی که فیلد image دارد و قبلاً حداقل یک‌بار (از طریق /img)
// دیده و OCR شده، متن OCR ذخیره‌شده در KV را در همان محصول ادغام می‌کند.
// این تابع بدون تغییر از نسخه‌ی قبلی حفظ شده؛ فقط حالا منبع products،
// D1 است نه KV.
async function mergeOcrTextIntoProducts(env, products) {
  var list = Array.isArray(products) ? products : [];
  for (var i = 0; i < list.length; i++) {
    var product = list[i];
    if (!product || !product.image || product.ocr_text) continue;
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

// نقطه‌ی ورود GET /catalog — حالا از D1 می‌خواند (نه KV)، با
// صفحه‌بندی اختیاری (limit/offset) تا کاتالوگ‌های خیلی بزرگ یک‌جا
// پاسخ را غیرقابل‌استفاده نکنند. کش لبه‌ای ۳ دقیقه‌ای هم حفظ شده.
async function handleCatalogRequest(request, env, ctx) {
  var cache = caches.default;
  var cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  var url = new URL(request.url);
  var limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  var offsetParam = parseInt(url.searchParams.get("offset") || "", 10);
  var limit = !isNaN(limitParam) && limitParam > 0 && limitParam <= CATALOG_MAX_LIMIT ? limitParam : CATALOG_DEFAULT_LIMIT;
  var offset = !isNaN(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  var origin = await getShopOriginFromKv(env);

  var countRow = await env.CATALOG_DB.prepare("SELECT COUNT(*) AS c FROM products").first();
  var totalProducts = (countRow && countRow.c) || 0;

  var rows = await env.CATALOG_DB
    .prepare("SELECT url, title, price, currency, image, in_stock, ocr_text, source FROM products ORDER BY id DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all();

  var products = ((rows && rows.results) || []).map(dbRowToProduct);

  try {
    products = await mergeOcrTextIntoProducts(env, products);
  } catch (mergeErr) {
    // نادیده گرفته می‌شود؛ کاتالوگ بدون ocr_text تازه برگردانده می‌شود
  }

  var payload = {
    origin: origin,
    products: products,
    totalProducts: totalProducts,
    limit: limit,
    offset: offset,
    updatedAt: Date.now(),
  };

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

// یک عبارت جست‌وجوی کاربر را به کوئری FTS5 (با پیشوندجویی روی هر کلمه)
// تبدیل می‌کند تا نیم‌کلمه/غلط تایپی جزئی هم نتیجه بدهد.
function buildFts5MatchQuery(q) {
  var words = String(q || "")
    .replace(/["]/g, " ")
    .split(/\s+/)
    .map(function (w) {
      return w.trim();
    })
    .filter(function (w) {
      return w.length >= 2;
    });
  if (!words.length) return "";

  var parts = words
    .map(function (w) {
      var escaped = w.replace(/[^\p{L}\p{N}]/gu, "");
      return escaped ? '"' + escaped + '"*' : null;
    })
    .filter(Boolean);

  if (!parts.length) return "";
  return parts.join(" OR ");
}

async function searchWithFts5(env, q, limit) {
  if (!q) {
    var rows0 = await env.CATALOG_DB
      .prepare("SELECT url, title, price, currency, image, in_stock, ocr_text, source FROM products ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all();
    var products0 = ((rows0 && rows0.results) || []).map(dbRowToProduct);
    return mergeOcrTextIntoProducts(env, products0);
  }

  var ftsQuery = buildFts5MatchQuery(q);
  if (!ftsQuery) return [];

  var rows;
  try {
    rows = await env.CATALOG_DB
      .prepare(
        "SELECT p.url, p.title, p.price, p.currency, p.image, p.in_stock, p.ocr_text, p.source " +
          "FROM products_fts f JOIN products p ON p.id = f.rowid " +
          "WHERE products_fts MATCH ? ORDER BY rank LIMIT ?"
      )
      .bind(ftsQuery, limit)
      .all();
  } catch (ftsErr) {
    return [];
  }

  var products = ((rows && rows.results) || []).map(dbRowToProduct);
  return mergeOcrTextIntoProducts(env, products);
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش ۴ — لایه‌ی جست‌وجوی معنایی Vectorize (اختیاری، با سقوط امن)
// ══════════════════════════════════════════════════════════════════════

// یک متن را با API رسمی embedContent گوگل به بردار ۷۶۸بعدی تبدیل
// می‌کند. هرگز throw نمی‌کند؛ در هر مشکلی null برمی‌گرداند.
async function embedTextWithGemini(geminiApiKey, text) {
  if (!text) return null;
  var endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    EMBEDDING_MODEL +
    ":embedContent?key=" +
    encodeURIComponent(geminiApiKey);

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, EMBEDDING_TIMEOUT_MS);

  try {
    var res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/" + EMBEDDING_MODEL,
        content: { parts: [{ text: text }] },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    var data = await res.json();
    var values = data && data.embedding && data.embedding.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) return null;
    return values;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function getStoredGeminiKey(env) {
  try {
    var raw = await env.CATALOG_KV.get(OCR_CONFIG_KEY);
    if (!raw) return null;
    var cfg = JSON.parse(raw);
    return (cfg && cfg.geminiApiKey) || null;
  } catch (e) {
    return null;
  }
}

// در هر اجرای scheduled()، حداکثر VECTOR_EMBED_BATCH_SIZE محصولِ
// «امبد‌نشده‌ی بعدی» را می‌گیرد، بردارشان را می‌سازد و در Vectorize
// ذخیره می‌کند. وقتی به انتهای جدول رسید، از اول (id=0) شروع می‌کند تا
// محصولاتی که بعداً ویرایش شدند هم به‌مرور دوباره امبد شوند. اگر
// Vectorize بایند نشده باشد یا کلید Gemini وصل نشده باشد، بی‌سروصدا
// و بدون خطا هیچ‌کاری نمی‌کند.
async function buildVectorizeIndexIncrementally(env) {
  if (!env.VECTOR_INDEX) return;

  try {
    var geminiApiKey = await getStoredGeminiKey(env);
    if (!geminiApiKey) return;

    var stateRow = await env.CATALOG_DB.prepare("SELECT * FROM embed_state WHERE id = 1").first();
    var lastId = (stateRow && stateRow.last_embedded_product_id) || 0;

    var rows = await env.CATALOG_DB
      .prepare("SELECT id, url, title, ocr_text FROM products WHERE id > ? ORDER BY id ASC LIMIT ?")
      .bind(lastId, VECTOR_EMBED_BATCH_SIZE)
      .all();

    var products = (rows && rows.results) || [];

    if (!products.length) {
      // به انتهای جدول رسیدیم؛ دور بعدی از اول شروع می‌شود تا محصولات
      // ویرایش‌شده هم به‌روز بمانند.
      await env.CATALOG_DB.prepare("UPDATE embed_state SET last_embedded_product_id = 0, last_run_at = ? WHERE id = 1")
        .bind(Date.now())
        .run();
      return;
    }

    var vectors = [];
    var maxId = lastId;

    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      maxId = Math.max(maxId, p.id);

      var text = ((p.title || "") + (p.ocr_text ? " " + p.ocr_text : "")).trim().slice(0, VECTOR_EMBED_TEXT_MAX_CHARS);
      if (!text) continue;

      var values = await embedTextWithGemini(geminiApiKey, text);
      if (values) {
        vectors.push({ id: "p" + p.id, values: values, metadata: { pid: p.id } });
      }
    }

    if (vectors.length) {
      await env.VECTOR_INDEX.upsert(vectors);
    }

    await env.CATALOG_DB
      .prepare("UPDATE embed_state SET last_embedded_product_id = ?, total_embedded = total_embedded + ?, last_run_at = ?, last_error = NULL WHERE id = 1")
      .bind(maxId, vectors.length, Date.now())
      .run();
  } catch (e) {
    try {
      await env.CATALOG_DB
        .prepare("UPDATE embed_state SET last_error = ?, last_run_at = ? WHERE id = 1")
        .bind(String((e && e.message) || e), Date.now())
        .run();
    } catch (e2) {}
  }
}

// جست‌وجوی معنایی: عبارت کاربر را امبد می‌کند، در Vectorize نزدیک‌ترین
// بردارها را پیدا می‌کند، بعد همان محصولات را از D1 (با همان ترتیب
// امتیاز) برمی‌دارد. اگر هر مرحله شکست بخورد (Vectorize بایند نشده،
// کلید Gemini نیست، خطای شبکه)، null برمی‌گرداند — فراخواننده باید به
// FTS5 سقوط کند، نه اینکه خطا بدهد.
async function searchWithVectorize(env, queryText, limit) {
  if (!env.VECTOR_INDEX) return null;

  var geminiApiKey = await getStoredGeminiKey(env);
  if (!geminiApiKey) return null;

  var queryVector = await embedTextWithGemini(geminiApiKey, queryText);
  if (!queryVector) return null;

  var matchResult;
  try {
    matchResult = await env.VECTOR_INDEX.query(queryVector, { topK: limit });
  } catch (e) {
    return null;
  }
  var matches = matchResult && matchResult.matches;
  if (!matches || !matches.length) return null;

  var pids = [];
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var pid = (m.metadata && m.metadata.pid) || parseInt(String(m.id || "").replace(/^p/, ""), 10);
    if (pid) pids.push(pid);
  }
  if (!pids.length) return null;

  var placeholders = pids.map(function () {
    return "?";
  }).join(",");

  var stmt = env.CATALOG_DB.prepare(
    "SELECT id, url, title, price, currency, image, in_stock, ocr_text, source FROM products WHERE id IN (" + placeholders + ")"
  );

  var rowsResult;
  try {
    rowsResult = await stmt.bind.apply(stmt, pids).all();
  } catch (e) {
    return null;
  }

  var rowsById = {};
  ((rowsResult && rowsResult.results) || []).forEach(function (r) {
    rowsById[r.id] = r;
  });

  var ordered = [];
  for (var j = 0; j < pids.length; j++) {
    var row = rowsById[pids[j]];
    if (row) ordered.push(dbRowToProduct(row));
  }
  if (!ordered.length) return null;

  return mergeOcrTextIntoProducts(env, ordered);
}

// نقطه‌ی ورود GET /search — اول Vectorize (اگر فعال بود)، در غیر این
// صورت (یا اگر شکست خورد) خودکار و بی‌صدا به FTS5 روی D1 سقوط می‌کند.
async function handleSearchRequest(request, env, ctx) {
  var url = new URL(request.url);
  var q = (url.searchParams.get("q") || url.searchParams.get("search") || "").trim();

  var vectorResults = null;
  if (q) {
    try {
      vectorResults = await searchWithVectorize(env, q, SEARCH_MAX_CANDIDATES);
    } catch (e) {
      vectorResults = null;
    }
  }

  if (vectorResults && vectorResults.length) {
    return json(
      { query: q, method: "vectorize", products: vectorResults },
      200,
      { "Cache-Control": "public, max-age=60" }
    );
  }

  var ftsResults = await searchWithFts5(env, q, SEARCH_MAX_CANDIDATES);
  return json(
    { query: q, method: "fts5", products: ftsResults },
    200,
    { "Cache-Control": "public, max-age=60" }
  );
}

// ══════════════════════════════════════════════════════════════════════
// روتینگ اصلی
// ══════════════════════════════════════════════════════════════════════

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

    if (url.pathname === "/search" && request.method === "GET") {
      return handleSearchRequest(request, env, ctx);
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

    if (url.pathname === "/setup-vectorize" && request.method === "POST") {
      return handleSetupVectorize(request, env);
    }
    if (url.pathname === "/vectorize-status" && request.method === "GET") {
      return handleVectorizeStatus(env);
    }

    return json({ error: "مسیر یافت نشد" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSelfRefreshCycle(env));
    ctx.waitUntil(buildVectorizeIndexIncrementally(env));
  },
};
