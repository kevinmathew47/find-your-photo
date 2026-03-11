import { NextResponse } from "next/server";
import { readdirSync } from "fs";
import { join } from "path";

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export async function GET() {
  try {
    const photosDir = join(process.cwd(), "public", "photos");
    const files = readdirSync(photosDir);
    const photos = files.filter((f) => {
      const ext = f.toLowerCase().slice(f.lastIndexOf("."));
      return ALLOWED_EXT.has(ext);
    });
    return NextResponse.json({ photos });
  } catch {
    return NextResponse.json({ photos: [] });
  }
}
