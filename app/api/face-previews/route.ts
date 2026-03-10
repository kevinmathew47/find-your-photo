import { NextResponse } from "next/server";
import { readdirSync } from "fs";
import { join } from "path";

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function GET() {
  try {
    const photosDir = join(process.cwd(), "public", "photos");
    const files = readdirSync(photosDir);
    const photos = files.filter((f) => {
      const ext = f.toLowerCase().slice(f.lastIndexOf("."));
      return ALLOWED_EXT.has(ext);
    });

    // Return up to 120 photos spread evenly across the gallery for face detection.
    // Larger sample = more faces found, while still keeping load manageable.
    const MAX = 120;
    const step = Math.max(1, Math.floor(photos.length / MAX));
    const sampled = photos.filter((_, i) => i % step === 0).slice(0, MAX);

    return NextResponse.json({ photos: sampled, total: photos.length });
  } catch {
    return NextResponse.json({ photos: [], total: 0 });
  }
}
