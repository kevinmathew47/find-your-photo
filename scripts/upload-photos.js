/**
 * upload-photos.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk-upload all event photos from public/photos/ to Cloudinary.
 *
 * Usage:
 *   1. Fill in your credentials in .env.local
 *   2. node scripts/upload-photos.js
 *
 * It is SAFE to re-run — Cloudinary will skip duplicates if you use the
 * same public_id (filename-based), so only new photos are uploaded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PHOTOS_DIR = path.join(__dirname, "../public/photos");
const FOLDER = process.env.CLOUDINARY_FOLDER || "event-photos";
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const BATCH_SIZE = 5; // upload 5 at a time to avoid rate limits

async function uploadPhoto(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;

  // Use filename (without ext) as the Cloudinary public_id so it's deterministic
  const publicId = `${FOLDER}/${path.basename(filename, ext)}`;

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      public_id: publicId,
      folder: "", // already included in public_id
      resource_type: "image",
      // Keep original quality, Cloudinary optimises on delivery
      quality: "auto",
      fetch_format: "auto",
      // If the photo already exists, skip upload
      overwrite: false,
      invalidate: false,
    });
    return result.secure_url;
  } catch (err) {
    // "already exists" is not a real error when overwrite=false
    if (err.http_code === 400 && err.message.includes("already exists")) {
      const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}`;
      return url;
    }
    throw err;
  }
}

async function main() {
  console.log("🚀 Starting Cloudinary upload...\n");
  console.log(`📁 Source: ${PHOTOS_DIR}`);
  console.log(`☁️  Destination: ${process.env.CLOUDINARY_CLOUD_NAME}/${FOLDER}\n`);

  if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === "your_cloud_name") {
    console.error("❌ ERROR: Please fill in your Cloudinary credentials in .env.local first!");
    console.error("   Get them from https://cloudinary.com/console");
    process.exit(1);
  }

  let files;
  try {
    files = fs.readdirSync(PHOTOS_DIR).filter((f) => ALLOWED_EXT.has(path.extname(f).toLowerCase()));
  } catch {
    console.error(`❌ Cannot read photos directory: ${PHOTOS_DIR}`);
    process.exit(1);
  }

  console.log(`📸 Found ${files.length} photos to upload\n`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const urls = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((f) => uploadPhoto(path.join(PHOTOS_DIR, f), f))
    );

    results.forEach((r, j) => {
      const filename = batch[j];
      if (r.status === "fulfilled" && r.value) {
        urls.push({ filename, url: r.value });
        uploaded++;
        process.stdout.write(`  ✅ [${i + j + 1}/${files.length}] ${filename}\n`);
      } else {
        failed++;
        process.stdout.write(`  ❌ [${i + j + 1}/${files.length}] ${filename} — ${r.reason?.message}\n`);
      }
    });

    // Small pause between batches to be kind to rate limits
    if (i + BATCH_SIZE < files.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`✅ Uploaded : ${uploaded}`);
  console.log(`⏭️  Skipped  : ${skipped} (already existed)`);
  console.log(`❌ Failed   : ${failed}`);
  console.log(`─────────────────────────────────────`);
  console.log(`\n🎉 Done! Your photos are live on Cloudinary.`);
  console.log(`   Now deploy your app — it will fetch photos from Cloudinary automatically.\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
