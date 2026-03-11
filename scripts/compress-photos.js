/**
 * compress-photos.js — compress all event photos for git
 * Tested with jimp v1.x. Resizes to max 1200px, JPEG 75% quality.
 * Usage: node scripts/compress-photos.js
 */

const { Jimp } = require("jimp");
const fs = require("fs");
const path = require("path");

const PHOTOS_DIR = path.join(__dirname, "../public/photos");
const MAX_WIDTH  = 1200;   // px
const QUALITY    = 75;     // JPEG %
const ALLOWED    = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CONCURRENCY = 4;     // process 4 at a time

async function compressOne(filePath) {
  const img = await Jimp.read(filePath);
  if (img.width > MAX_WIDTH) {
    img.resize({ w: MAX_WIDTH });
  }
  // Always output as .jpg (renames .jpeg/.png/.webp → .jpg)
  const outPath = filePath.replace(/\.(jpeg|png|webp)$/i, ".jpg");
  await img.write(outPath, { quality: QUALITY });
  if (outPath !== filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return outPath;
}

async function runBatch(batch) {
  return Promise.allSettled(batch.map(({ file, fp }) =>
    compressOne(fp).then(() => ({ file, ok: true })).catch(e => ({ file, ok: false, err: e.message }))
  ));
}

async function main() {
  // Clean up test files
  ["_test_out.jpg", "_test_resized.jpg"].forEach(f => {
    const p = path.join(PHOTOS_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  const files = fs.readdirSync(PHOTOS_DIR)
    .filter(f => ALLOWED.has(path.extname(f).toLowerCase()))
    .map(f => ({ file: f, fp: path.join(PHOTOS_DIR, f) }));

  const startBytes = files.reduce((s, { fp }) => s + fs.statSync(fp).size, 0);
  console.log(`\n🗜️  Compressing ${files.length} photos → max ${MAX_WIDTH}px @ ${QUALITY}% quality`);
  console.log(`📦 Total before: ${(startBytes / 1024 / 1024 / 1024).toFixed(2)} GB\n`);

  let ok = 0, failed = 0, done = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await runBatch(batch);
    for (const r of results) {
      done++;
      if (r.value?.ok) { ok++; }
      else {
        failed++;
        if (r.value?.err) console.error(`  ❌ ${r.value.file}: ${r.value.err}`);
      }
    }
    const pct = Math.round((done / files.length) * 100);
    process.stdout.write(`  [${String(pct).padStart(3)}%] ${done}/${files.length} — ✅ ${ok}  ❌ ${failed}\r`);
  }

  const afterFiles = fs.readdirSync(PHOTOS_DIR)
    .filter(f => ALLOWED.has(path.extname(f).toLowerCase()));
  const endBytes = afterFiles.reduce((s, f) => s + fs.statSync(path.join(PHOTOS_DIR, f)).size, 0);
  const afterMB   = endBytes / 1024 / 1024;

  console.log(`\n\n──────────────────────────────────────────`);
  console.log(`✅ Compressed : ${ok}`);
  console.log(`❌ Failed     : ${failed}`);
  console.log(`📦 Before     : ${(startBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`📦 After      : ${afterMB.toFixed(0)} MB`);
  console.log(`💾 Saved      : ${((startBytes - endBytes) / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`──────────────────────────────────────────`);

  if (afterMB > 900) {
    console.log(`\n⚠️  >900MB — re-run with MAX_WIDTH=900 to shrink further`);
  } else {
    console.log(`\n🎉 Ready! Now run the push commands shown below.\n`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
