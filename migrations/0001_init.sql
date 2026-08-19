-- migrations/0001_init.sql
-- این فایل ساختار پایگاه‌داده‌ی D1 فروشگاه شما را می‌سازد.
-- هر بار که این migration اجرا شود، اگر جدول‌ها از قبل وجود داشته باشند
-- (به‌خاطر IF NOT EXISTS) هیچ خطایی نمی‌دهد و هیچ داده‌ای پاک نمی‌شود.

-- جدول اصلی محصولات. هر ردیف یک محصول از فروشگاه است.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  price TEXT,
  currency TEXT,
  image TEXT,
  in_stock INTEGER NOT NULL DEFAULT 1,
  ocr_text TEXT,
  source TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ایندکس روی url برای جست‌وجوی سریع هنگام به‌روزرسانی محصول تکراری.
CREATE INDEX IF NOT EXISTS idx_products_url ON products(url);

-- جدول مجازی FTS5 برای جست‌وجوی تمام‌متن روی عنوان و متن OCR.
-- از حالت "content='products'" استفاده شده یعنی خودِ متن دوباره
-- کپی نمی‌شود، فقط ایندکس جست‌وجو ساخته می‌شود؛ این باعث می‌شود
-- فضای اشغالی این جدول تقریباً نصف حالت معمولی باشد.
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  title,
  ocr_text,
  content='products',
  content_rowid='id'
);

-- سه تریگر زیر، جدول products_fts را همیشه و خودکار هماهنگ با
-- جدول products نگه می‌دارند. یعنی شما هرگز مستقیم چیزی در
-- products_fts نمی‌نویسید؛ فقط در products بنویسید/ویرایش/حذف کنید،
-- این تریگرها بقیه‌ی کار را خودشان انجام می‌دهند.

CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, title, ocr_text)
  VALUES (new.id, new.title, new.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, ocr_text)
  VALUES ('delete', old.id, old.title, old.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, ocr_text)
  VALUES ('delete', old.id, old.title, old.ocr_text);
  INSERT INTO products_fts(rowid, title, ocr_text)
  VALUES (new.id, new.title, new.ocr_text);
END;

-- جدول وضعیت خزش (crawl). فقط همیشه یک ردیف دارد (id همیشه ۱ است)
-- و همان یک ردیف، محل نگهداری "نشانگر ازسرگیری" خزش تدریجی است که
-- در بخش ۲ استفاده می‌شود. همین الان ساختنش می‌گذاریم که بخش ۲ نیازی
-- به migration دوم نداشته باشد.
CREATE TABLE IF NOT EXISTS crawl_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL DEFAULT 'idle',
  sitemap_urls TEXT NOT NULL DEFAULT '[]',
  next_index INTEGER NOT NULL DEFAULT 0,
  total_found INTEGER NOT NULL DEFAULT 0,
  total_crawled INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT
);

INSERT OR IGNORE INTO crawl_state (id, phase, sitemap_urls, next_index, total_found, total_crawled)
VALUES (1, 'idle', '[]', 0, 0, 0);

-- جدول وضعیت ساخت بردار embedding (برای Vectorize، بخش ۴).
-- همین الان می‌سازیمش تا در بخش ۴ نیازی به migration دیگری نباشد.
CREATE TABLE IF NOT EXISTS embed_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_embedded_product_id INTEGER NOT NULL DEFAULT 0,
  total_embedded INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT
);

INSERT OR IGNORE INTO embed_state (id, last_embedded_product_id, total_embedded)
VALUES (1, 0, 0);
