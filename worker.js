/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ بخش ۱ - جدید (زیرساخت ذخیره‌سازی عکس):
 * این نسخه یک بخش کاملاً جدید و مستقل اضافه می‌کند که به فروشنده اجازه
 * می‌دهد یک «توکن گیت‌هاب محدود» و «آدرس مخزن خودش» را وارد کند. این دو
 * مقدار، بعد از یک تست اعتبارسنجی واقعی روی گیت‌هاب، در KV همین Worker
 * (یعنی حساب خودِ فروشنده، نه سرور مرکزی من) ذخیره می‌شوند.
 *
 * ‼️ مهم: در همین بخش (۱)، هیچ عکسی خزیده، دانلود یا آپلود نمی‌شود.
 * فقط زیرساخت (گرفتن و ذخیره‌ی امن اعتبارنامه) ساخته شده. خزش و آپلود
 * واقعی عکس‌ها در «بخش ۲» پیاده‌سازی خواهد شد و از همین پیکربندی که
 * اینجا ذخیره می‌شود استفاده می‌کند.
 *
 * هیچ منطق دیگری (fetch handler قبلی، مسیرهای /، /internal-token، /setup،
 * /update، /catalog، صفحه‌ی landing قبلی، دکمه‌ی «اتصال خودکار»، Cron
 * Trigger و چرخه‌ی self-refresh) تغییر نکرده است.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";
const IMAGE_CONFIG_KEY = "image-config"; // ‼️ بخش ۱ - جدید

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
const CENTRAL_SERVER_URL = "https://shop-assistant.laana9258.workers.dev";

// ‼️ جدید — تنظیمات مخصوص چرخه‌ی خودکار ساعتی (self-refresh). این
// اعداد عمداً محتاطانه انتخاب شده‌اند تا داخل سقف رایگان (۵۰ ساب‌ریکوئست،
// ۱۰ میلی‌ثانیه CPU در هر اجرا) بمانند، حتی برای فروشگاه‌های نسبتاً بزرگ.
const SELF_REFRESH_BOT_UA =
  "SA-ShopSelfRefresh/1.0 (+https://ai-assistant-cpl.pages.dev/bot-info)";
const SELF_REFRESH_FETCH_TIMEOUT_MS = 10000;
const SELF_REFRESH_MAX_RESPONSE_CHARS = 900000;
const SELF_REFRESH_MAX_PAGES = 18;
const SELF_REFRESH_MAX_PRODUCTS = 200;
const SELF_REFRESH_PRODUCT_PATH_HINTS = ["/product", "/products", "/shop/", "/item/", "/p/"];

// ‼️ بخش ۱ - جدید — تنظیمات مخصوص اعتبارسنجی توکن گیت‌هاب
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_UA = "AI-Shop-Assistant-ImageStore/1.0";
const GITHUB_VALIDATE_TIMEOUT_MS = 10000;

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
// ‼️ بخش ۱ - جدید — کمکی‌های مستقل برای پیکربندی ذخیره‌سازی عکس در گیت‌هاب
// هیچ‌کدام از این توابع در جای دیگری از فایل فراخوانی نمی‌شوند مگر همان
// دو مسیر جدید (/save-image-config و /image-config-status) پایین‌تر.
// ══════════════════════════════════════════════════════════════════════

// آدرس مخزن را که فروشنده به هر شکلی (با https://, بدون آن, با اسلش
// انتهایی, با .git) وارد کند، به {owner, repo} تمیز تبدیل می‌کند.
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

// یک تماس واقعی و سبک به گیت‌هاب می‌زند تا مطمئن شود توکن معتبر است و
// واقعاً به همان مخزن دسترسی نوشتن دارد. هرگز throw نمی‌کند.
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

// وضعیت فعلی را برمی‌گرداند، ولی هرگز خودِ توکن را در پاسخ نمی‌فرستد —
// این مسیر توسط جاوااسکریپت همین صفحه صدا زده می‌شود تا وضعیت را نشان دهد.
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
// پایان بخش ۱ (زیرساخت ذخیره‌سازی عکس)
// ══════════════════════════════════════════════════════════════════════

// ‼️ صفحه‌ی landing — به بخش قبلی (اتصال خودکار) دست نخورده، فقط یک
// کارت جدید («۲) اتصال انبار عکس») به‌صورت کاملاً مستقل زیرش اضافه شده.
// جاوااسکریپت این کارت جدید کاملاً مستقل از جاوااسکریپت بالای صفحه است؛
// اگر این بخش جدید هر خطایی بدهد، بخش «اتصال خودکار» بالای صفحه دقیقاً
// مثل قبل کار می‌کند.
function landingPageHtml() {
  return (
    "<!DOCTYPE html>" +
    '<html lang="fa" dir="rtl"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    "<title>اتصال انبار فروشگاه</title>" +
    "<style>" +
    "body{font-family:Tahoma,Vazirmatn,sans-serif;background:#FAF6ED;margin:0;padding:24px;" +
    "display:flex;align-items:center;justify-content:center;min-height:100vh;box-sizing:border-box;}" +
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
    // ‼️ بخش ۱ - جدید — جاوااسکریپت کارت «اتصال انبار عکس»
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
    "refreshImageStatus();" +
    "</script></body></html>"
  );
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ بخش self-refresh (بدون تغییر نسبت به نسخه‌ی قبلی)
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

    // ‼️ بخش ۱ - جدید — دو مسیر تازه برای پیکربندی ذخیره‌سازی عکس
    if (url.pathname === "/save-image-config" && request.method === "POST") {
      return handleSaveImageConfig(request, env);
    }
    if (url.pathname === "/image-config-status" && request.method === "GET") {
      return handleImageConfigStatus(env);
    }

    return json({ error: "مسیر یافت نشد" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSelfRefreshCycle(env));
  },
};
