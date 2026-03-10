import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const FOLDER = process.env.CLOUDINARY_FOLDER || "event-photos";

/** Fetch full photo list from Cloudinary (server-side, used on Vercel) */
async function listFromCloudinary(): Promise<string[]> {
  const { v2: cloudinary } = await import("cloudinary");
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  const allUrls: string[] = [];
  let nextCursor: string | undefined;

  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await cloudinary.api.resources({
      type: "upload",
      prefix: FOLDER + "/",
      resource_type: "image",
      max_results: 500,
      next_cursor: nextCursor,
    });
    for (const r of result.resources) {
      // Return the secure URL so it works cross-origin in the browser
      allUrls.push(r.secure_url);
    }
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return allUrls;
}

/** Fetch photo list from local public/photos directory (for local dev) */
function listFromLocal(): string[] {
  const photosDir = join(process.cwd(), "public", "photos");
  if (!existsSync(photosDir)) return [];
  return readdirSync(photosDir).filter((f) => {
    const ext = f.toLowerCase().slice(f.lastIndexOf("."));
    return ALLOWED_EXT.has(ext);
  });
}

export async function GET() {
  try {
    const hasCloudinary =
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_CLOUD_NAME !== "your_cloud_name" &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET;

    if (hasCloudinary) {
      // ── Cloudinary mode (Vercel / production) ───────────────────────────
      const urls = await listFromCloudinary();
      // Return objects with url + filename derived from the URL
      const photos = urls.map((url) => ({
        url,
        filename: url.split("/").pop() || url,
      }));
      return NextResponse.json({ photos, source: "cloudinary" });
    } else {
      // ── Local mode (development) ─────────────────────────────────────────
      const files = listFromLocal();
      const photos = files.map((f) => ({ url: `/photos/${f}`, filename: f }));
      return NextResponse.json({ photos, source: "local" });
    }
  } catch (err) {
    console.error("list-photos error:", err);
    return NextResponse.json({ photos: [], source: "error" });
  }
}
