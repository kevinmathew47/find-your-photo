import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const FOLDER = process.env.CLOUDINARY_FOLDER || "event-photos";

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
      allUrls.push(r.secure_url);
    }
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return allUrls;
}

export async function GET() {
  try {
    const hasCloudinary =
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_CLOUD_NAME !== "your_cloud_name" &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET;

    let allPhotos: { url: string; filename: string }[] = [];

    if (hasCloudinary) {
      // Cloudinary mode
      const urls = await listFromCloudinary();
      allPhotos = urls.map((url) => ({
        url,
        filename: url.split("/").pop() || url,
      }));
    } else {
      // Local dev mode
      const photosDir = join(process.cwd(), "public", "photos");
      if (existsSync(photosDir)) {
        const files = readdirSync(photosDir).filter((f) => {
          const ext = f.toLowerCase().slice(f.lastIndexOf("."));
          return ALLOWED_EXT.has(ext);
        });
        allPhotos = files.map((f) => ({ url: `/photos/${f}`, filename: f }));
      }
    }

    // Return up to 120 photos spread evenly across the gallery for face detection.
    const MAX = 120;
    const step = Math.max(1, Math.floor(allPhotos.length / MAX));
    const sampled = allPhotos.filter((_, i) => i % step === 0).slice(0, MAX);

    return NextResponse.json({
      photos: sampled.map((p) => p.url),
      filenames: sampled.map((p) => p.filename),
      total: allPhotos.length,
    });
  } catch (err) {
    console.error("face-previews error:", err);
    return NextResponse.json({ photos: [], filenames: [], total: 0 });
  }
}
