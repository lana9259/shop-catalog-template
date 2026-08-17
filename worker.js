/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ تغییر این نسخه (بروزرسانی خودکار ساعتی، بدون هیچ دخالت فروشنده و
 * بدون هیچ هزینه یا ترافیک روی سرور مرکزی من):
 *
 * یک Cron Trigger — تعریف‌شده در wrangler.toml همین قالب، هر ۱ ساعت
 * یک‌بار — تابع scheduled() پایین همین فایل را روی حساب رایگان خودِ
 * فروشنده اجرا می‌کند. این تابع:
 *   ۱) از KV خودِ همین Worker می‌خواند که آخرین «origin» (آدرس سایت
 *      فروشگاه) کدام بود (همان چیزی که سرور مرکزی هنگام اولین اتصال
 *      در /update فرستاده و ذخیره کرده).
 *   ۲) مستقیماً از همان سایت (نه از طریق سرور مرکزی من) دوباره
 *      محصولات را می‌خواند — یا با تلاش برای یک API مستقیم محصولات،
 *      یا با خزیدنِ محترمانه (احترام به robots.txt) روی sitemap سایت.
 *   ۳) نتیجه را مستقیماً در KV خودِ همین Worker می‌نویسد.
 *
 * نتیجه: نه یک ساب‌ریکوئست، نه یک ردیف از سقف ۱۰۰,۰۰۰ درخواست روزانه‌ی
 * حساب Cloudflare من مصرف می‌شود — چون اصلاً پای سرور مرکزی من در این
 * چرخه نیست. با ۱۰۰ فروشگاه یا ۱۰ میلیون فروشگاه فرقی برای حساب من
 * ندارد؛ هرکدام فقط سقف رایگان مستقل خودشان را مصرف می‌کنند.
 *
 * صداقتِ فنی (مهم): پلن رایگان Cloudflare برای هر اجرای Worker (از جمله
 * Cron) سقف ۱۰ میلی‌ثانیه CPU و ۵۰ ساب‌ریکوئست دارد. زمان انتظار برای
 * fetch جزو CPU حساب نمی‌شود، ولی پردازش HTML (regex/JSON.parse) می‌شود.
 * به همین دلیل این تابع عمداً: (الف) تعداد صفحات را کم نگه می‌دارد،
 * (ب) robots.txt را فقط یک‌بار در کل چرخه می‌خواند نه به‌ازای هر صفحه،
 * (ج) حجم HTML خوانده‌شده را محدود می‌کند، و (د) کل تابع در try/catch
 * پوشیده شده — اگر یک چرخه به هر دلیلی (شامل برخورد به سقف CPU) شکست
 * بخورد، هیچ‌چیز کاربر یا کاتالوگ موجود را خراب نمی‌کند؛ کاتالوگ قبلی
 * دست‌نخورده می‌ماند و ساعت بعد دوباره تلاش می‌شود.
 *
 * هیچ منطق دیگری (fetch handler، مسیرهای /، /internal-token، /setup،
 * /update، /catalog، صفحه‌ی landing و دکمه‌ی «اتصال خودکار») تغییر
 * نکرده است.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
// اگر روزی آدرس سرور مرکزی عوض شد، فقط همین یک خط باید در این قالب
// به‌روزرسانی شود (و همه‌ی فروشندگانی که از این پس دیپلوی می‌کنند،
// نسخه‌ی جدید را می‌گیرند؛ فروشندگان قبلی همچنان با آدرس قدیمی کار
// می‌کنند مگر دوباره دیپلوی کنند).
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

// ‼️ صفحه‌ی جدید: یک دکمه‌ی اصلی «اتصال خودکار» (می‌خواند از کلیپ‌بورد،
// بدون نیاز به تایپ) + یک کادر متنی کوچک‌تر به‌عنوان پشتیبان دستی.
// جاوااسکریپت همین صفحه (نه فروشنده) کار زیر را انجام می‌دهد:
//   ۱) از مسیر داخلی /internal-token (هم‌مبدأ، بدون CORS) توکن را می‌خواند
//   ۲) آدرس خودش را از window.location.origin می‌گیرد
//   ۳) کد را یا از کلیپ‌بورد (خودکار) یا از کادر متنی (دستی) می‌گیرد
//   ۴) هر سه را به سرور مرکزی می‌فرستد
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
    "box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center;}" +
    "h1{font-size:19px;color:#0A3838;margin:0 0 10px;}" +
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
    "button.secondary{width:100%;padding:14px;font-size:15px;font-weight:700;color:#0A3838;" +
    "background:#D9A441;border:none;border-radius:10px;cursor:pointer;}" +
    "button:disabled{opacity:.5;}" +
    "#msg{margin-top:16px;font-size:13.5px;min-height:20px;}" +
    ".ok{color:#1f5c3a;} .err{color:#8a4b1c;}" +
    "</style></head><body>" +
    '<div class="card">' +
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
    "<script>" +
    "function toggleManual(){" +
    'var box=document.getElementById("manualBox");' +
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
    "</script></body></html>"
  );
}

// ══════════════════════════════════════════════════════════════════════
// ‼️ جدید — بخش خودکفای «بروزرسانی خودکار ساعتی» (self-refresh).
// همه‌ی کمکی‌های زیر مستقل و کامل‌اند؛ هیچ‌کدام به سرور مرکزی من یا به
// هیچ چیز خارج از همین Worker وابسته نیستند.
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

// ‼️ برخلاف نسخه‌ی سرور مرکزی که robots.txt را به‌ازای هر صفحه دوباره
// می‌خواند، این نسخه فقط یک‌بار در کل چرخه می‌خواند و قوانین را
// برمی‌گرداند — برای صرفه‌جویی در سقف ۵۰ ساب‌ریکوئست حساب فروشنده.
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

// خزیدن سبک و محتاطانه: robots.txt فقط یک‌بار خوانده می‌شود، تعداد
// صفحات محدود است، و هر خطای غیرمنتظره روی یک صفحه فقط همان صفحه را
// نادیده می‌گیرد، نه کل چرخه را متوقف می‌کند.
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

// نقطه‌ی ورود چرخه‌ی خودکار ساعتی. عمداً هیچ‌گاه throw نمی‌کند — بدترین
// حالت این است که این چرخه بی‌نتیجه تمام شود و کاتالوگ فعلی دست‌نخورده
// بماند تا ساعت بعد دوباره تلاش شود.
async function runSelfRefreshCycle(env) {
  try {
    var raw = await env.CATALOG_KV.get(CATALOG_KEY);
    if (!raw) return; // هنوز هیچ اتصالی کامل نشده؛ چیزی برای بروزرسانی نیست

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

    // اگر این چرخه هیچ محصولی پیدا نکرد (مثلاً سایت موقتاً در دسترس
    // نبود)، به‌جای جایگزینی کاتالوگ خوب قبلی با یک نتیجه‌ی خالی،
    // کاتالوگ فعلی را دست‌نخورده نگه می‌داریم.
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
    // هر خطای پیش‌بینی‌نشده‌ی دیگری (شامل برخورد به سقف CPU/زمان رایگان
    // Cloudflare) اینجا بی‌سروصدا بلعیده می‌شود. کاتالوگ فعلی سالم
    // می‌ماند و چرخه‌ی بعدی (۱ ساعت دیگر) خودکار دوباره تلاش می‌کند.
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

    // صفحه‌ی اصلی و ساده‌ی اتصال (این چیزی است که فروشنده باز می‌کند)
    if (url.pathname === "/" && request.method === "GET") {
      return html(landingPageHtml());
    }

    // فقط خودِ همین صفحه (هم‌مبدأ) این مسیر را می‌خواند؛ فروشنده هرگز
    // مستقیم به این آدرس نمی‌رود و توکن را نمی‌بیند.
    if (url.pathname === "/internal-token" && request.method === "GET") {
      var tokenForPage = await getOrCreateToken(env);
      return json({ token: tokenForPage });
    }

    // ── مسیر قدیمی (JSON خام) — فقط برای عیب‌یابی دستی نگه داشته شده ──
    if (url.pathname === "/setup" && request.method === "GET") {
      var token = await getOrCreateToken(env);
      return json({
        message:
          "این دو مقدار مخصوص فروشگاه شماست. آن‌ها را با هیچ‌کس به اشتراک نگذارید.",
        workerBaseUrl: url.origin,
        updateToken: token,
      });
    }

    // ── فقط سرور مرکزی (با توکن درست) اجازه‌ی نوشتن محصولات دارد ──
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

    // ── خریداران مستقیم از همین‌جا می‌خوانند — عمومی، کش‌شونده ──
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

    return json({ error: "مسیر یافت نشد" }, 404);
  },

  // ‼️ جدید — نقطه‌ی ورود Cron Trigger. بازه‌ی زمانی در wrangler.toml
  // همین قالب تعریف شده (هر ۱ ساعت). ctx.waitUntil تضمین می‌کند که
  // اجرای غیرهمزمانِ چرخه، پیش از پایان اجرای Worker، کامل می‌شود.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSelfRefreshCycle(env));
  },
};
