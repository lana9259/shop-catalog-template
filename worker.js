/**
 * worker.js — این فایل روی حساب شخصی خودِ فروشنده اجرا می‌شود، نه حساب من.
 *
 * ‼️ تغییر این نسخه (کاهش مرحله‌ی اتصال از «تایپ/paste دستی» به «یک کلیک»):
 * صفحه‌ی اصلی (/) حالا یک دکمه‌ی بزرگ «اتصال خودکار» دارد که با یک کلیک،
 * کد را خودش با navigator.clipboard.readText() از کلیپ‌بورد کاربر می‌خواند
 * (چون سایت ما همان لحظه‌ی ساختن کد، آن را در کلیپ‌بورد کاربر کپی کرده)
 * و بلافاصله بدون نیاز به تایپ یا paste دستی، فرآیند اتصال را کامل می‌کند.
 *
 * اگر خواندن خودکار کلیپ‌بورد به هر دلیلی (نبود مجوز مرورگر، کلیپ‌بورد
 * خالی/نامعتبر) ناموفق بود، همان کادر متنی قدیمی + دکمه‌ی «اتصال دستی»
 * به‌عنوان پشتیبان کامل، بدون هیچ تغییری در رفتار، در دسترس می‌ماند —
 * یعنی هیچ مسیر موفقیت قبلی خراب نمی‌شود، فقط یک مسیر سریع‌تر اضافه شده.
 *
 * مسیر /setup قدیمی هم برای سازگاری/عیب‌یابی دستی باقی مانده و حذف نشده.
 * مسیرهای /update و /catalog دقیقاً بدون هیچ تغییری از نسخه‌ی قبلی حفظ
 * شده‌اند. مسیر /internal-token و منطق سرور (/claim) هم دست‌نخورده است —
 * فقط HTML/JS صفحه‌ی landing تغییر کرده.
 */

const CATALOG_KEY = "catalog";
const TOKEN_KEY = "update-token";

// ‼️ آدرس سرور مرکزی — همانی که در سایت ما (worker.js اصلی) هست.
// اگر روزی آدرس سرور مرکزی عوض شد، فقط همین یک خط باید در این قالب
// به‌روزرسانی شود (و همه‌ی فروشندگانی که از این پس دیپلوی می‌کنند،
// نسخه‌ی جدید را می‌گیرند؛ فروشندگان قبلی همچنان با آدرس قدیمی کار
// می‌کنند مگر دوباره دیپلوی کنند).
const CENTRAL_SERVER_URL = "https://shop-assistant.laana9258.workers.dev";

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
};
