/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ بخش ۱ (زیرساخت ذخیره‌سازی عکس): بدون تغییر نسبت به قبل.
 * ‼️ بخش ۲ (خزش و آپلود خودکار عکس‌ها): بدون تغییر نسبت به قبل.
 *
 * ‼️ بخش ۳ - جدید (استخراج OCR در زمان ایندکس):
 * در همان چرخه‌ی ساعتی self-refresh، بعد از این‌که بخش ۲ آدرس CDN عکس
 * را ساخت، یک مرحله‌ی اضافی جدید اجرا می‌شود:
 *   ۱) اگر فروشنده هنوز کلید Gemini خودش را وارد نکرده (یعنی
 *      env.CATALOG_KV کلید ocr-config را ندارد)، این مرحله کاملاً رد
 *      می‌شود — هیچ رفتاری نسبت به قبل از این تغییر عوض نمی‌شود.
 *   ۲) اگر انجام داده باشد، فقط برای محصولاتی که از قبل یک image_cdn
 *      دارند (یعنی عکسشان از قبل با موفقیت در مخزن خودِ فروشنده کش شده)
 *      این مرحله اجرا می‌شود — هرگز مستقیم از سایت اصلی فروشنده عکس
 *      خوانده نمی‌شود، همیشه از همان آدرس CDN خودِ فروشنده.
 *      - اگر همان image_cdn در چرخه‌ی قبلی قبلاً یک‌بار OCR شده بود
 *        (یعنی در کاتالوگ ذخیره‌شده‌ی قبلی یک ocr_text برایش ثبت شده،
 *        حتی رشته‌ی خالی)، همان مقدار قبلی دوباره استفاده می‌شود — هیچ
 *        فراخوانی تکراری به Gemini اتفاق نمی‌افتد.
 *      - در غیر این صورت، اگر هنوز به سقف ۳ استخراج-جدید-در-این-چرخه
 *        نرسیده باشیم، عکس یک‌بار از CDN خودِ فروشنده دانلود و به
 *        Gemini (همان مدل چندوجهی‌ای که app.js استفاده می‌کند) داده
 *        می‌شود تا هر متن ریزی که روی عکس هست دقیق استخراج شود؛ نتیجه
 *        در فیلد جدید ocr_text کنار همان محصول در کاتالوگ ذخیره می‌شود.
 *   ۳) سقف ۳ استخراج در هر چرخه عمداً محافظه‌کارانه انتخاب شده تا در
 *      کنار خزش متن (تا ۱۹ ساب‌ریکوئست) و آپلود عکس (تا ۲۴ ساب‌ریکوئست)،
 *      مجموع از سقف ۵۰ ساب‌ریکوئست رایگان هر اجرای Worker رد نشود
 *      (۱۹ + ۲۴ + ۳×۲ = ۴۹، هنوز زیر ۵۰). برای فروشگاه‌های بزرگ، متن
 *      OCR عکس‌ها به‌تدریج، ساعت به ساعت، کامل می‌شود — نه همه یک‌جا.
 *   ۴) هر خطا در این مرحله (چه در یک عکس خاص، چه در کل مرحله) کاملاً
 *      بی‌سروصدا بلعیده می‌شود؛ کاتالوگ متنی و عکس‌ها همیشه ذخیره
 *      می‌شوند، حتی اگر OCR آن ساعت به هر دلیلی شکست بخورد.
 *   ۵) یک بخش تازه در صفحه‌ی landing («۳) اتصال کلید OCR») اضافه شده
 *      تا فروشنده بتواند یک کلید رایگان Gemini API (بدون کارت بانکی)
 *      را وارد و تست کند — دقیقاً هم‌الگو با بخش «اتصال انبار عکس»ی که
 *      از قبل وجود داشت.
 *
 * هیچ منطق دیگری (fetch handler قبلی، مسیرهای /، /internal-token،
 * /setup، /update، /catalog، /save-image-config، /image-config-status،
 * دکمه‌ی «اتصال خودکار»، Cron Trigger، بخش ۱ و بخش ۲) تغییر نکرده است.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";
const IMAGE_CONFIG_KEY = "image-config";
const OCR_CONFIG_KEY = "ocr-config"; // ‼️ جدید — بخش ۳

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
const CENTRAL_SERVER_URL = "https://shop-assistant.laana9258.workers.dev";

// ‼️ تنظیمات مخصوص چرخه‌ی خودکار ساعتی (self-refresh). این اعداد عمداً
// محتاطانه انتخاب شده‌اند تا داخل سقف رایگان (۵۰ ساب‌ریکوئست، ۱۰
// میلی‌ثانیه CPU در هر اجرا) بمانند، حتی برای فروشگاه‌های نسبتاً بزرگ.
const SELF_REFRESH_BOT_UA =
  "SA-ShopSelfRefresh/1.0 (+https://ai-assistant-cpl.pages.dev/bot-info)";
const SELF_REFRESH_FETCH_TIMEOUT_MS = 10000;
const SELF_REFRESH_MAX_RESPONSE_CHARS = 900000;
const SELF_REFRESH_MAX_PAGES = 18;
const SELF_REFRESH_MAX_PRODUCTS = 200;
const SELF_REFRESH_PRODUCT_PATH_HINTS = ["/product", "/products", "/shop/", "/item/", "/p/"];

// ‼️ تنظیمات مخصوص اعتبارسنجی توکن گیت‌هاب (بخش ۱)
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_UA = "AI-Shop-Assistant-ImageStore/1.0";
const GITHUB_VALIDATE_TIMEOUT_MS = 10000;

// ‼️ بخش ۲ — تنظیمات مخصوص خزش و آپلود عکس
const IMAGE_UPLOAD_MAX_BYTES = 6 * 1024 * 1024; // بیش از ۶ مگابایت، آن عکس رد می‌شود
const IMAGE_UPLOAD_MAX_PER_CYCLE = 12; // سقف آپلود «جدید» در هر اجرای ساعتی
const IMAGE_UPLOAD_FETCH_TIMEOUT_MS = 10000;
const GITHUB_UPLOAD_TIMEOUT_MS = 10000;

// ‼️ بخش ۳ - جدید — تنظیمات مخصوص استخراج OCR
const OCR_GEMINI_MODEL = "gemini-3.1-flash-lite"; // همان مدلی که app.js برای چت هم استفاده می‌کند
const OCR_GEMINI_TIMEOUT_MS = 12000;
const OCR_IMAGE_FETCH_TIMEOUT_MS = 10000;
const OCR_MAX_PER_CYCLE = 3; // سقف استخراج «جدید» در هر اجرای ساعتی
const OCR_MAX_TEXT_CHARS = 2000; // سقف طول متن ذخیره‌شده برای هر محصول، تا حجم KV زیاد نشود
const OCR_EMPTY_MARKER = "(بدون متن)";

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

// ══════════════════════════════════════════════════════════════════════
// بخش ۱ — کمکی‌های مستقل برای پیکربندی ذخیره‌سازی عکس در گیت‌هاب
// (بدون تغییر نسبت به نسخه‌ی قبلی)
// ══════════════════════════════════════════════════════════════════════

function parseGithubRepoUrl(raw) {
  if (!raw) return null;
  var cleaned = String(raw).trim();
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  cleaned = cleaned.replace(/\.git$/i, "");
  cleaned = cleaned.replace(/^\/+|\/+$/g, "");
  var parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  var owner = parts[0];
  var repo = parts[1];
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner: owner, repo: repo };
}

async function validateGithubAccess(owner, repo, token) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, GITHUB_VALIDATE_TIMEOUT_MS);

  try {
    var res = await fetch(
      GITHUB_API_BASE + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo),
      {
        headers: {
          Authorization: "Bearer " + token,
          "User-Agent": GITHUB_API_UA,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "توکن معتبر نیست یا دسترسی کافی به این مخزن ندارد." };
    }
    if (res.status === 404) {
      return { ok: false, error: "این مخزن پیدا نشد. آدرس را دوباره بررسی کنید یا مطمئن شوید توکن به آن دسترسی دارد." };
    }
    if (!res.ok) {
      return { ok: false, error: "گیت‌هاب پاسخ غیرمنتظره‌ای داد (HTTP " + res.status + ")." };
    }

    var data = await res.json();
    var permissions = data && data.permissions;
    var canPush = !!(permissions && permissions.push);
    if (!canPush) {
      return {
        ok: false,
        error:
          "توکن به این مخزن متصل شد، اما اجازه‌ی «نوشتن» (Read and write روی Contents) ندارد. لطفاً توکن را دوباره با دسترسی درست بسازید.",
      };
    }

    return { ok: true, defaultBranch: data.default_branch || "main", fullName: data.full_name || owner + "/" + repo };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: "اتصال به گیت‌هاب برقرار نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید." };
  }
}

async function handleSaveImageConfig(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "بدنه‌ی درخواست نامعتبر است" }, 400);
  }
  if (!body || !body.repoUrl || !body.githubToken) {
    return json({ error: "آدرس مخزن و توکن هر دو لازم هستند" }, 400);
  }

  var parsedRepo = parseGithubRepoUrl(body.repoUrl);
  if (!parsedRepo) {
    return json(
      { error: "آدرس مخزن نامعتبر است. باید چیزی شبیه github.com/username/shop-catalog-template باشد." },
      400
    );
  }

  var token = String(body.githubToken).trim();
  if (!token) {
    return json({ error: "توکن نمی‌تواند خالی باشد" }, 400);
  }

  var validation = await validateGithubAccess(parsedRepo.owner, parsedRepo.repo, token);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  await env.CATALOG_KV.put(
    IMAGE_CONFIG_KEY,
    JSON.stringify({
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      defaultBranch: validation.defaultBranch,
      githubToken: token,
      savedAt: Date.now(),
    })
  );

  return json({
    ok: true,
    repoFullName: validation.fullName,
    message: "انبار ذخیره‌سازی عکس با موفقیت متصل و تأیید شد.",
  });
}

async function handleImageConfigStatus(env) {
  var raw = await env.CATALOG_KV.get(IMAGE_CONFIG_KEY);
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
    repoFullName: cfg.owner + "/" + cfg.repo,
    savedAt: cfg.savedAt || null,
  });
}

// ══════════════════════════════════════════════════════════════════════
// پایان بخش ۱
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش ۳ - جدید — کمکی‌های مستقل برای پیکربندی کلید Gemini (OCR)
// ══════════════════════════════════════════════════════════════════════

// یک تماس بسیار کوچک و ارزان با Gemini می‌زند فقط برای اینکه مطمئن شود
// کلید معتبر است؛ هیچ عکسی اینجا رد و بدل نمی‌شود.
async function validateGeminiKey(apiKey) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, GITHUB_VALIDATE_TIMEOUT_MS);

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
// پایان کمکی‌های پیکربندی بخش ۳
// ══════════════════════════════════════════════════════════════════════

// ‼️ صفحه‌ی landing — همان نسخه‌ی قبلی + یک کارت جدید برای اتصال کلید OCR.
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
    "#imgMsg{margin-top:16px;font-size:13.5px;min-height:20px;text-align:right;}" +
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
    "<h2 style=\"text-align:center;\">🖼️ ۲) اتصال انبار عکس (پیشنهاد می‌شود)</h2>" +
    '<div id="imgStatusPill" class="status-pill off" style="display:block;text-align:center;">در حال بررسی وضعیت...</div>' +
    "<p>این بخش باعث می‌شود عکس محصولات شما با بالاترین کیفیت، در مخزن گیت‌هاب خودتان (همانی که با دکمه‌ی نارنجی بالا ساختید) ذخیره شود — رایگان، بدون کارت بانکی، و کاملاً روی حساب خودتان.</p>" +
    '<label class="field-label">آدرس مخزن گیت‌هاب شما</label>' +
    '<input id="repoUrlInput" class="wide" type="text" placeholder="github.com/username-شما/shop-catalog-template">' +
    '<label class="field-label">توکن گیت‌هاب (Fine-grained token)</label>' +
    '<input id="githubTokenInput" class="wide" type="password" placeholder="github_pat_...">' +
    '<button id="saveImgConfigBtn" class="secondary" onclick="saveImageConfig()">💾 ذخیره و تست اتصال</button>' +
    '<button type="button" class="fallback-toggle" onclick="toggleImgHelp()" style="display:block;margin:10px auto 0;">نمی‌دانم این توکن چیست و از کجا بسازم؟</button>' +
    '<div id="imgHelpBox" class="help-box" style="display:none;">' +
    "<b>این توکن یک «کلید محدود» است که فقط اجازه می‌دهد ابزار ما در همان یک مخزن شما عکس بنویسد؛ به هیچ چیز دیگری در حساب گیت‌هاب شما دسترسی ندارد.</b>" +
    "<ol>" +
    "<li>در مرورگر گوشی‌تان به آدرس <b>github.com</b> بروید و با همان حسابی که هنگام ساخت انبار ذخیره‌سازی (دکمه‌ی نارنجی بالا) استفاده کردید، وارد شوید.</li>" +
    "<li>روی عکس پروفایل‌تان (گوشه‌ی بالا سمت راست صفحه) بزنید و «Settings» را انتخاب کنید.</li>" +
    "<li>پایین‌ترین صفحه را باز کنید و روی «Developer settings» بزنید (آخرین گزینه‌ی منوی سمت چپ/پایین است).</li>" +
    "<li>روی «Personal access tokens» بزنید، سپس روی «Fine-grained tokens».</li>" +
    "<li>دکمه‌ی «Generate new token» را بزنید.</li>" +
    "<li>در قسمت «Token name» هر اسمی دلخواه بنویسید، مثلاً: AI-Shop-Images</li>" +
    "<li>در قسمت «Expiration»، طولانی‌ترین گزینه‌ی موجود (معمولاً ۳۶۶ روز یا No expiration) را انتخاب کنید. اگر «No expiration» نبود، همان ۳۶۶ روز کافی است — نزدیک آن تاریخ باید یک توکن جدید بسازید.</li>" +
    "<li>در «Repository access» گزینه‌ی «Only select repositories» را بزنید، سپس همان مخزنی که در بالای همین صفحه آدرسش را وارد کردید (معمولاً به اسم shop-catalog-template) را از لیست پیدا و انتخاب کنید.</li>" +
    "<li>پایین‌تر بروید تا «Permissions» را ببینید؛ روی «Repository permissions» بزنید، دنبال ردیف «Contents» بگردید و مقابلش را از «No access» به «Read and write» تغییر دهید.</li>" +
    "<li>پایین صفحه را باز کنید و دکمه‌ی سبز «Generate token» را بزنید.</li>" +
    "<li>یک متن طولانی که با <b>github_pat_</b> شروع می‌شود نشان داده می‌شود. روی آیکون کپی کنارش بزنید — این تنها فرصت شماست برای دیدن آن؛ اگر از این صفحه بیرون بروید دیگر نمایش داده نمی‌شود.</li>" +
    "<li>به همین صفحه برگردید، آن متن کپی‌شده را در کادر «توکن گیت‌هاب» بالا بچسبانید (لمس‌نگه‌دارید روی کادر و «Paste» را بزنید)، سپس روی «ذخیره و تست اتصال» بزنید.</li>" +
    "</ol>" +
    "</div>" +
    '<div id="imgMsg"></div>' +
    "</div>" +

    '<div class="card" style="text-align:right;">' +
    "<h2 style=\"text-align:center;\">🔎 ۳) اتصال کلید خواندن متن روی عکس (OCR)</h2>" +
    '<div id="ocrStatusPill" class="status-pill off" style="display:block;text-align:center;">در حال بررسی وضعیت...</div>' +
    "<p>این بخش باعث می‌شود دستیار بتواند نوشته‌های ریز روی عکس محصولات (مثلاً برچسب یک کرم آرایشی) را هم بخواند. کاملاً رایگان است و به هیچ کارت بانکی نیاز ندارد.</p>" +
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
    "function toggleImgHelp(){" +
    'var box=document.getElementById("imgHelpBox");' +
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
    "async function refreshImageStatus(){" +
    'var pill=document.getElementById("imgStatusPill");' +
    "try{" +
    'var res=await fetch("/image-config-status");' +
    "var data=await res.json();" +
    "if(data && data.configured){" +
    'pill.className="status-pill on";' +
    'pill.textContent="✅ متصل — انبار: "+data.repoFullName;' +
    "}else{" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز متصل نشده";' +
    "}" +
    "}catch(e){" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز متصل نشده";' +
    "}" +
    "}" +
    "async function saveImageConfig(){" +
    'var repoInput=document.getElementById("repoUrlInput");' +
    'var tokenInput=document.getElementById("githubTokenInput");' +
    'var btn=document.getElementById("saveImgConfigBtn");' +
    'var msgEl=document.getElementById("imgMsg");' +
    "var repoUrl=repoInput.value.trim();" +
    "var token=tokenInput.value.trim();" +
    "if(!repoUrl || !token){" +
    'msgEl.className="err";msgEl.textContent="لطفاً هم آدرس مخزن و هم توکن را وارد کنید.";' +
    "return;" +
    "}" +
    "btn.disabled=true;" +
    'msgEl.className="";msgEl.textContent="در حال تست اتصال به گیت‌هاب...";' +
    "try{" +
    'var res=await fetch("/save-image-config",{' +
    'method:"POST",headers:{"Content-Type":"application/json"},' +
    "body:JSON.stringify({repoUrl:repoUrl,githubToken:token})});" +
    "var data=await res.json();" +
    "if(!res.ok){" +
    'msgEl.className="err";msgEl.textContent=data.error||"اتصال ناموفق بود.";' +
    "btn.disabled=false;" +
    "return;" +
    "}" +
    'msgEl.className="ok";msgEl.textContent="✅ "+data.message+" ("+data.repoFullName+")";' +
    "tokenInput.value=\"\";" +
    "btn.disabled=false;" +
    "refreshImageStatus();" +
    "}catch(e){" +
    'msgEl.className="err";msgEl.textContent="اتصال به سرور برقرار نشد. اینترنت را بررسی کنید.";' +
    "btn.disabled=false;" +
    "}" +
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
    'pill.textContent="⏳ هنوز متصل نشده";' +
    "}" +
    "}catch(e){" +
    'pill.className="status-pill off";' +
    'pill.textContent="⏳ هنوز متصل نشده";' +
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
    "refreshImageStatus();" +
    "refreshOcrStatus();" +
    "</script></body></html>"
  );
}

// ══════════════════════════════════════════════════════════════════════
// بخش self-refresh — خزش متن (بدون تغییر نسبت به نسخه‌ی قبلی)
// ══════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════
// بخش ۲ — خزش و آپلود خودکار عکس‌ها به مخزن گیت‌هاب فروشنده
// (بدون تغییر نسبت به نسخه‌ی قبلی)
// ══════════════════════════════════════════════════════════════════════

async function sha256Hex(arrayBuffer) {
  var digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
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

function guessImageExtension(contentType, imageUrl) {
  var ct = String(contentType || "").toLowerCase();
  if (ct.indexOf("png") !== -1) return "png";
  if (ct.indexOf("webp") !== -1) return "webp";
  if (ct.indexOf("gif") !== -1) return "gif";
  if (ct.indexOf("jpeg") !== -1 || ct.indexOf("jpg") !== -1) return "jpg";
  try {
    var pathname = new URL(imageUrl).pathname.toLowerCase();
    var m = pathname.match(/\.(png|webp|gif|jpe?g)$/);
    if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  } catch (e) {}
  return "jpg";
}

async function downloadImageBytes(imageUrl) {
  var parsed;
  try {
    parsed = new URL(imageUrl);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isPrivateOrDisallowedHost(parsed.hostname)) return null;

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, IMAGE_UPLOAD_FETCH_TIMEOUT_MS);

  try {
    var res = await fetch(imageUrl, {
      headers: { "User-Agent": SELF_REFRESH_BOT_UA, Accept: "image/*" },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 0 },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    var contentType = res.headers.get("content-type") || "";
    var buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength > IMAGE_UPLOAD_MAX_BYTES) {
      return null;
    }
    return { bytes: new Uint8Array(buffer), buffer: buffer, contentType: contentType };
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function uploadImageToGithub(imageConfig, path, base64Content) {
  var apiUrl =
    GITHUB_API_BASE +
    "/repos/" +
    encodeURIComponent(imageConfig.owner) +
    "/" +
    encodeURIComponent(imageConfig.repo) +
    "/contents/" +
    path;

  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, GITHUB_UPLOAD_TIMEOUT_MS);

  try {
    var res = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + imageConfig.githubToken,
        "User-Agent": GITHUB_API_UA,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "افزودن عکس محصول (آپلود خودکار توسط دستیار خرید هوشمند)",
        content: base64Content,
        branch: imageConfig.defaultBranch || "main",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 200 || res.status === 201) return { ok: true };
    if (res.status === 422) return { ok: true };
    return { ok: false };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false };
  }
}

async function uploadOneImageAndGetCdnUrl(imageConfig, imageUrl) {
  var downloaded = await downloadImageBytes(imageUrl);
  if (!downloaded) return null;

  var hash;
  try {
    hash = await sha256Hex(downloaded.buffer);
  } catch (e) {
    return null;
  }

  var ext = guessImageExtension(downloaded.contentType, imageUrl);
  var path = "images/" + hash + "." + ext;

  var base64Content;
  try {
    base64Content = uint8ToBase64(downloaded.bytes);
  } catch (e) {
    return null;
  }

  var uploadResult = await uploadImageToGithub(imageConfig, path, base64Content);
  if (!uploadResult.ok) return null;

  var branch = imageConfig.defaultBranch || "main";
  return (
    "https://cdn.jsdelivr.net/gh/" +
    imageConfig.owner +
    "/" +
    imageConfig.repo +
    "@" +
    branch +
    "/" +
    path
  );
}

async function attachImageCdnUrls(env, products, previousProducts) {
  var imageConfigRaw;
  try {
    imageConfigRaw = await env.CATALOG_KV.get(IMAGE_CONFIG_KEY);
  } catch (e) {
    return products;
  }
  if (!imageConfigRaw) return products;

  var imageConfig;
  try {
    imageConfig = JSON.parse(imageConfigRaw);
  } catch (e) {
    return products;
  }
  if (!imageConfig || !imageConfig.owner || !imageConfig.repo || !imageConfig.githubToken) {
    return products;
  }

  var previousMap = {};
  if (Array.isArray(previousProducts)) {
    for (var i = 0; i < previousProducts.length; i++) {
      var prev = previousProducts[i];
      if (prev && prev.image && prev.image_cdn) {
        previousMap[prev.image] = prev.image_cdn;
      }
    }
  }

  var uploadsUsedThisCycle = 0;

  for (var j = 0; j < products.length; j++) {
    var product = products[j];
    if (!product || !product.image) continue;

    var existingCdn = previousMap[product.image];
    if (existingCdn) {
      product.image_cdn = existingCdn;
      continue;
    }

    if (uploadsUsedThisCycle >= IMAGE_UPLOAD_MAX_PER_CYCLE) {
      continue;
    }

    uploadsUsedThisCycle++;
    try {
      var cdnUrl = await uploadOneImageAndGetCdnUrl(imageConfig, product.image);
      if (cdnUrl) {
        product.image_cdn = cdnUrl;
      }
    } catch (perImageErr) {}
  }

  return products;
}

// ══════════════════════════════════════════════════════════════════════
// پایان بخش ۲
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش ۳ - جدید — استخراج OCR در زمان ایندکس
// هیچ‌کدام از این توابع در جای دیگری از فایل فراخوانی نمی‌شوند مگر
// runSelfRefreshCycle در پایین همین بخش، و فقط بعد از بخش ۲.
// ══════════════════════════════════════════════════════════════════════

// عکس را از آدرس CDN خودِ فروشنده (نه از سایت اصلی فروشنده) می‌خواند و
// از Gemini چندوجهی می‌خواهد هر متن ریزی روی آن هست را دقیق استخراج
// کند. هرگز throw نمی‌کند؛ در هر مشکلی رشته‌ی خالی برمی‌گرداند تا
// فراخواننده بدون توقف کل چرخه ادامه دهد.
async function extractOcrTextFromImage(geminiApiKey, imageCdnUrl) {
  var imgController = new AbortController();
  var imgTimeoutId = setTimeout(function () {
    imgController.abort();
  }, OCR_IMAGE_FETCH_TIMEOUT_MS);

  var imageRes;
  try {
    imageRes = await fetch(imageCdnUrl, {
      headers: { Accept: "image/*" },
      signal: imgController.signal,
      cf: { cacheTtl: 0 },
    });
  } catch (e) {
    clearTimeout(imgTimeoutId);
    return "";
  }
  clearTimeout(imgTimeoutId);
  if (!imageRes || !imageRes.ok) return "";

  var contentType = imageRes.headers.get("content-type") || "image/jpeg";
  var buffer;
  try {
    buffer = await imageRes.arrayBuffer();
  } catch (e) {
    return "";
  }
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength > IMAGE_UPLOAD_MAX_BYTES) return "";

  var base64Data;
  try {
    base64Data = uint8ToBase64(new Uint8Array(buffer));
  } catch (e) {
    return "";
  }

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

  var apiController = new AbortController();
  var apiTimeoutId = setTimeout(function () {
    apiController.abort();
  }, OCR_GEMINI_TIMEOUT_MS);

  var res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: apiController.signal,
    });
  } catch (e) {
    clearTimeout(apiTimeoutId);
    return "";
  }
  clearTimeout(apiTimeoutId);
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

// برای کل آرایه‌ی محصولات این چرخه، فیلد ocr_text را (در صورت امکان)
// پر می‌کند. اگر فروشنده هنوز کلید Gemini را وارد نکرده، بدون هیچ
// کاری همان products را برمی‌گرداند (رفتار قبلی، دست‌نخورده).
async function attachOcrText(env, products, previousProducts) {
  var ocrConfigRaw;
  try {
    ocrConfigRaw = await env.CATALOG_KV.get(OCR_CONFIG_KEY);
  } catch (e) {
    return products;
  }
  if (!ocrConfigRaw) return products;

  var ocrConfig;
  try {
    ocrConfig = JSON.parse(ocrConfigRaw);
  } catch (e) {
    return products;
  }
  if (!ocrConfig || !ocrConfig.geminiApiKey) return products;

  // نگاشت «آدرس CDN عکس → متن OCR که قبلاً برایش استخراج شده» را از
  // کاتالوگ چرخه‌ی قبلی می‌سازیم تا از فراخوانی تکراری Gemini برای
  // همان عکس جلوگیری شود. مقدار خالی هم یک نتیجه‌ی معتبر است (یعنی آن
  // عکس متنی ندارد) و باید حفظ شود، نه دوباره امتحان شود.
  var previousMap = {};
  if (Array.isArray(previousProducts)) {
    for (var i = 0; i < previousProducts.length; i++) {
      var prev = previousProducts[i];
      if (prev && prev.image_cdn && typeof prev.ocr_text === "string") {
        previousMap[prev.image_cdn] = prev.ocr_text;
      }
    }
  }

  var ocrUsedThisCycle = 0;

  for (var j = 0; j < products.length; j++) {
    var product = products[j];

    // فقط عکس‌هایی که از قبل در CDN خودِ فروشنده کش شده‌اند بررسی
    // می‌شوند — این یعنی هیچ‌وقت مستقیم به سایت اصلی فروشنده برای OCR
    // درخواستی زده نمی‌شود.
    if (!product || !product.image_cdn) continue;

    var existingOcr = previousMap[product.image_cdn];
    if (typeof existingOcr === "string") {
      product.ocr_text = existingOcr;
      continue;
    }

    if (ocrUsedThisCycle >= OCR_MAX_PER_CYCLE) {
      // به سقف این چرخه رسیدیم؛ این محصول در چرخه‌ی ساعتی بعدی امتحان می‌شود
      continue;
    }

    ocrUsedThisCycle++;
    try {
      var extractedText = await extractOcrTextFromImage(ocrConfig.geminiApiKey, product.image_cdn);
      product.ocr_text = extractedText;
    } catch (perImageErr) {
      // این یک عکس شکست خورد؛ بقیه‌ی چرخه بدون وقفه ادامه پیدا می‌کند.
      // فیلد ocr_text عمداً ست نمی‌شود تا چرخه‌ی بعدی دوباره امتحان کند.
    }
  }

  return products;
}

// ══════════════════════════════════════════════════════════════════════
// پایان بخش ۳
// ══════════════════════════════════════════════════════════════════════

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

    // بخش ۲ — تلاش برای پر کردن image_cdn روی محصولات این چرخه.
    try {
      products = await attachImageCdnUrls(env, products, current && current.products);
    } catch (imageStageErr) {
      // نادیده گرفته می‌شود؛ ادامه با همان products بدون image_cdn
    }

    // ‼️ بخش ۳ - جدید — تلاش برای پر کردن ocr_text روی محصولاتی که
    // image_cdn دارند. هر خطای پیش‌بینی‌نشده در کل این مرحله بی‌سروصدا
    // بلعیده می‌شود؛ کاتالوگ و عکس‌های بخش ۲، در هر صورت، ذخیره می‌شوند.
    try {
      products = await attachOcrText(env, products, current && current.products);
    } catch (ocrStageErr) {
      // نادیده گرفته می‌شود؛ ادامه با همان products بدون ocr_text
    }

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

export default {
  async fetch(request, env) {
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
      var raw = await env.CATALOG_KV.get(CATALOG_KEY);
      if (!raw) {
        return json({ origin: "", products: [], updatedAt: null }, 200, {
          "Cache-Control": "public, max-age=300",
        });
      }
      var data = JSON.parse(raw);
      return json(data, 200, { "Cache-Control": "public, max-age=300" });
    }

    if (url.pathname === "/save-image-config" && request.method === "POST") {
      return handleSaveImageConfig(request, env);
    }
    if (url.pathname === "/image-config-status" && request.method === "GET") {
      return handleImageConfigStatus(env);
    }

    // ‼️ بخش ۳ - جدید — مسیرهای پیکربندی کلید OCR
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
