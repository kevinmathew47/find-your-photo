"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";

interface FaceCluster {
  id: number;
  photoFilename: string;
  photoUrl: string;
  descriptor: number[];
  faceBox: { x: number; y: number; width: number; height: number };
  /** Natural dimensions of the source image (needed for correct canvas crop) */
  imgNaturalWidth: number;
  imgNaturalHeight: number;
  /** Face area in pixels – used for sorting (bigger = clearer crop) */
  faceArea: number;
  /** Canvas data URL of the cropped face – for crisp display */
  cropDataUrl: string;
}

const DB_NAME = "photo-finder-cache";
// Version 4: stores faceBoxes alongside descriptors for proper canvas crops.
const DB_VERSION = 4;
const STORE = "descriptors";

type CacheEntry = {
  filename: string;
  descriptors: number[][];
  faceBoxes: { x: number; y: number; width: number; height: number }[];
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Delete old store (clears stale cache without faceBoxes) then recreate
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      db.createObjectStore(STORE, { keyPath: "filename" });
      void e; // suppress unused var warning
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(
  db: IDBDatabase,
  filename: string
): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(filename);
    req.onsuccess = () => {
      const v = req.result as CacheEntry | undefined;
      // Only use cache if it has faceBoxes (v4 format)
      resolve(v && v.faceBoxes ? v : null);
    };
    req.onerror = () => resolve(null);
  });
}

async function putCached(
  db: IDBDatabase,
  entry: CacheEntry
): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Crop and draw exactly the face area onto a small canvas, then return a
 * data URL.  Uses a generous padding ratio so the full head is visible.
 */
function buildCropDataUrl(
  img: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number },
  outputSize = 180
): string {
  const PAD = 0.55; // 55% padding around the tight box → shows forehead/chin
  const padX = box.width * PAD;
  const padY = box.height * PAD;

  const sx = Math.max(0, box.x - padX);
  const sy = Math.max(0, box.y - padY);
  const sw = Math.min(img.naturalWidth - sx, box.width + padX * 2);
  const sh = Math.min(img.naturalHeight - sy, box.height + padY * 2);

  // Draw onto a square canvas
  const size = Math.max(sw, sh); // keep it square so it fills the circle
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outputSize, outputSize);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function LandingPage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [faceClusters, setFaceClusters] = useState<FaceCluster[]>([]);
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "done">("idle");
  const [scanProgress, setScanProgress] = useState(0);
  const faceapiRef = useRef<typeof import("face-api.js") | null>(null);

  // ── Particle background ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles: {
      x: number; y: number; r: number; dx: number; dy: number; alpha: number;
    }[] = [];

    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.5 + 0.5,
        dx: (Math.random() - 0.5) * 0.4,
        dy: (Math.random() - 0.5) * 0.4,
        alpha: Math.random() * 0.5 + 0.1,
      });
    }

    let animId: number;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(167, 139, 250, ${p.alpha})`;
        ctx.fill();
        p.x += p.dx;
        p.y += p.dy;
        if (p.x < 0 || p.x > canvas.width) p.dx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
      });
      animId = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", handleResize);
    return () => { cancelAnimationFrame(animId); window.removeEventListener("resize", handleResize); };
  }, []);

  // ── Face Scanning ─────────────────────────────────────────────────────────
  const runFaceScan = useCallback(async () => {
    setScanStatus("scanning");
    setScanProgress(0);

    try {
      // Load face-api
      let faceapi = faceapiRef.current;
      if (!faceapi) {
        faceapi = await import("face-api.js");
        faceapiRef.current = faceapi;
      }
      const MODEL_URL = "/models";

      // Load only the models we actually need (Tiny is faster)
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);

      // Fetch photos – now returns full URLs (Cloudinary or /photos/file.jpg)
      const res = await fetch("/api/face-previews");
      if (!res.ok) return;
      const { photos } = (await res.json()) as { photos: string[] };
      if (!photos.length) { setScanStatus("done"); return; }

      let db: IDBDatabase | null = null;
      try { db = await openDB(); } catch { /* no idb */ }

      // Mutable cluster array – mutated in-place for speed, then sorted before setState
      const clusters: FaceCluster[] = [];
      const CLUSTER_THRESHOLD = 0.5;

      // ── Preload all images in parallel first, then process ──────────────
      // We preload everything upfront so processing batches don't wait on network
      const BATCH = 12; // bigger batches = faster overall

      for (let i = 0; i < photos.length; i += BATCH) {
        const batch = photos.slice(i, i + BATCH);

        await Promise.all(
          batch.map(async (photoUrl) => {
            // photoUrl is a full URL: either /photos/file.jpg (local) or https://res.cloudinary.com/...
            // Use URL as the cache key so it works for both local and Cloudinary
            const cacheKey = photoUrl;
            try {
              // --- Load image first (always needed for canvas crop) ---
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.src = photoUrl;
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject();
                setTimeout(() => reject(), 10000);
              });

              let descriptors: number[][];
              let faceBoxes: { x: number; y: number; width: number; height: number }[];

              // --- Cache check (v4: has faceBoxes) ---
              const cached = db ? await getCached(db, cacheKey) : null;

              if (cached) {
                // Perfect cache hit: use stored descriptors AND boxes directly
                descriptors = cached.descriptors;
                faceBoxes = cached.faceBoxes;
              } else {
                // Full detection with landmarks + descriptors (TinyFaceDetector)
                let detsFull: {
                  detection: { box: { x: number; y: number; width: number; height: number } };
                  descriptor: Float32Array;
                }[] = [];

                try {
                  const r = await faceapi!
                    .detectAllFaces(img, new faceapi!.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
                    .withFaceLandmarks(true)
                    .withFaceDescriptors();
                  detsFull = r as typeof detsFull;
                } catch { /* fall through */ }

                if (!detsFull.length) return; // no face found, skip

                descriptors = detsFull.map((d) => Array.from(d.descriptor));
                faceBoxes = detsFull.map((d) => ({
                  x: d.detection.box.x,
                  y: d.detection.box.y,
                  width: d.detection.box.width,
                  height: d.detection.box.height,
                }));

                // Cache both descriptors AND faceBoxes for instant reuse
                if (db && descriptors.length > 0) {
                  await putCached(db, { filename: cacheKey, descriptors, faceBoxes });
                }
              }

              if (!descriptors || !faceBoxes.length) return;

              // Cluster each detected face
              descriptors.forEach((desc, fi) => {
                const box = faceBoxes[fi] ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
                const matched = clusters.find(
                  (c) => euclideanDistance(c.descriptor, desc) < CLUSTER_THRESHOLD
                );
                if (!matched) {
                  // Build a crisp face crop data URL from the actual image
                  const cropDataUrl = buildCropDataUrl(img, box, 180);
                  clusters.push({
                    id: clusters.length,
                    photoFilename: photoUrl.split("/").pop() || photoUrl,
                    photoUrl: photoUrl,
                    descriptor: desc,
                    faceBox: box,
                    imgNaturalWidth: img.naturalWidth,
                    imgNaturalHeight: img.naturalHeight,
                    faceArea: box.width * box.height,
                    cropDataUrl,
                  });
                }
              });
            } catch { /* skip failed photos */ }
          })
        );

        setScanProgress(Math.round(((i + BATCH) / photos.length) * 100));

        // Sort clusters: largest face area first (clearest / most prominent)
        clusters.sort((a, b) => b.faceArea - a.faceArea);

        // Push an immutable copy to React state
        setFaceClusters(clusters.map((c, newIdx) => ({ ...c, id: newIdx })));

        // Yield to keep UI responsive
        await new Promise((r) => setTimeout(r, 0));
      }

      setScanStatus("done");
    } catch (err) {
      console.error("Face scan error:", err);
      setScanStatus("done");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runFaceScan(), 600);
    return () => clearTimeout(t);
  }, [runFaceScan]);

  const handleFaceClick = useCallback(
    (cluster: FaceCluster) => {
      sessionStorage.setItem("selfie_descriptor", JSON.stringify(cluster.descriptor));
      sessionStorage.setItem("selfie_image", cluster.photoUrl);
      sessionStorage.setItem("face_search_mode", "cluster");
      router.push("/results");
    },
    [router]
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        position: "relative",
        overflow: "hidden",
        padding: "24px",
      }}
    >
      {/* Particle canvas */}
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed", top: 0, left: 0,
          width: "100%", height: "100%",
          pointerEvents: "none", zIndex: 0,
        }}
      />

      {/* Glow orbs */}
      <div style={{
        position: "fixed", top: "10%", left: "15%",
        width: "400px", height: "400px",
        background: "radial-gradient(circle, rgba(124, 58, 237, 0.12) 0%, transparent 70%)",
        borderRadius: "50%", pointerEvents: "none", zIndex: 0, filter: "blur(40px)",
      }} />
      <div style={{
        position: "fixed", bottom: "10%", right: "15%",
        width: "300px", height: "300px",
        background: "radial-gradient(circle, rgba(109, 40, 217, 0.1) 0%, transparent 70%)",
        borderRadius: "50%", pointerEvents: "none", zIndex: 0, filter: "blur(40px)",
      }} />

      {/* ─── Hero section ─── */}
      <div style={{
        position: "relative", zIndex: 1,
        display: "flex", flexDirection: "column", alignItems: "center",
        textAlign: "center", maxWidth: "700px", width: "100%", paddingTop: "60px",
      }}>
        {/* Badge */}
        <div
          className="animate-fade-up glass-card"
          style={{
            display: "inline-flex", alignItems: "center", gap: "8px",
            padding: "6px 18px", borderRadius: "50px", fontSize: "13px",
            color: "var(--accent-light)", marginBottom: "32px", letterSpacing: "0.05em",
          }}
        >
          <span style={{ fontSize: "16px" }}>✦</span>
          AI-Powered · Instant · Private
        </div>

        {/* Main heading */}
        <h1
          className="animate-fade-up delay-100 gradient-text-white"
          style={{
            fontSize: "clamp(48px, 10vw, 96px)", fontWeight: 800,
            lineHeight: 1.05, letterSpacing: "-0.03em", marginBottom: "20px",
          }}
        >
          Find Your
          <br />
          <span className="gradient-text">Photos</span>
        </h1>

        {/* Subtext */}
        <p
          className="animate-fade-up delay-200"
          style={{
            fontSize: "clamp(16px, 2.5vw, 20px)",
            color: "rgba(240, 240, 245, 0.55)",
            lineHeight: 1.7, marginBottom: "52px", maxWidth: "520px",
          }}
        >
          Take a quick selfie — or tap your face below — and our AI instantly
          finds every photo of&nbsp;you from the event gallery.
        </p>

        {/* CTA Button */}
        <div className="animate-fade-up delay-300" style={{ position: "relative", display: "inline-block" }}>
          <div style={{
            position: "absolute", inset: "-12px", borderRadius: "50%",
            border: "1px solid rgba(124, 58, 237, 0.25)",
            animation: "ripple 2s ease-out infinite",
          }} />
          <div style={{
            position: "absolute", inset: "-12px", borderRadius: "50%",
            border: "1px solid rgba(124, 58, 237, 0.15)",
            animation: "ripple 2s ease-out infinite 0.6s",
          }} />
          <button
            id="take-selfie-btn"
            className="btn-primary animate-pulse-glow"
            onClick={() => router.push("/camera")}
            style={{
              padding: "22px 52px", fontSize: "18px", letterSpacing: "0.01em",
              display: "flex", alignItems: "center", gap: "12px",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            Take a Selfie
          </button>
        </div>

        {/* Feature pills */}
        <div
          className="animate-fade-up delay-500"
          style={{
            display: "flex", flexWrap: "wrap", justifyContent: "center",
            gap: "12px", marginTop: "56px",
          }}
        >
          {[
            { icon: "⚡", label: "Lightning Fast" },
            { icon: "🔒", label: "Fully Private" },
            { icon: "🎯", label: "High Accuracy" },
            { icon: "📱", label: "Mobile Friendly" },
          ].map((f) => (
            <div
              key={f.label}
              className="glass-card"
              style={{
                padding: "10px 20px", borderRadius: "50px", fontSize: "14px",
                color: "rgba(240, 240, 245, 0.65)",
                display: "flex", alignItems: "center", gap: "8px",
              }}
            >
              <span>{f.icon}</span>
              {f.label}
            </div>
          ))}
        </div>
      </div>

      {/* ─── Face Grid Section ─── */}
      <div style={{
        position: "relative", zIndex: 1, width: "100%", maxWidth: "900px",
        marginTop: "80px", paddingBottom: "80px",
      }}>
        {/* Section header */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <h2 style={{
            fontSize: "clamp(22px, 4vw, 32px)", fontWeight: 700,
            background: "linear-gradient(135deg, #ffffff 0%, #a78bfa 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            backgroundClip: "text", marginBottom: "8px",
          }}>
            Browse by Face
          </h2>
          <p style={{ color: "rgba(240, 240, 245, 0.45)", fontSize: "15px" }}>
            {scanStatus === "scanning"
              ? `Scanning gallery for faces… ${scanProgress}%`
              : scanStatus === "done" && faceClusters.length > 0
                ? `Found ${faceClusters.length} unique face${faceClusters.length !== 1 ? "s" : ""} — tap yours to find all your photos`
                : scanStatus === "done"
                  ? "No faces detected in gallery previews"
                  : "Preparing face scan…"}
          </p>

          {/* Scan progress bar */}
          {scanStatus === "scanning" && (
            <div style={{
              margin: "16px auto 0", height: "4px",
              background: "rgba(255,255,255,0.07)", borderRadius: "2px",
              overflow: "hidden", maxWidth: "300px",
            }}>
              <div style={{
                height: "100%", width: `${scanProgress}%`,
                background: "linear-gradient(90deg, #7c3aed, #a78bfa)",
                borderRadius: "2px", transition: "width 0.3s ease",
                boxShadow: "0 0 8px rgba(167,139,250,0.6)",
              }} />
            </div>
          )}
        </div>

        {/* Face grid */}
        {faceClusters.length > 0 && (
          <div style={{
            display: "flex", flexWrap: "wrap", gap: "20px", justifyContent: "center",
          }}>
            {faceClusters.map((cluster, idx) => (
              <FaceCard
                key={cluster.id}
                cluster={cluster}
                idx={idx}
                onClick={() => handleFaceClick(cluster)}
              />
            ))}
          </div>
        )}

        {/* Skeleton loaders while scanning */}
        {scanStatus === "scanning" && faceClusters.length === 0 && (
          <div style={{
            display: "flex", flexWrap: "wrap", gap: "20px", justifyContent: "center",
          }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: "90px", height: "90px", borderRadius: "50%",
                  background: "linear-gradient(135deg, rgba(124,58,237,0.08), rgba(124,58,237,0.02))",
                  border: "2px solid rgba(124,58,237,0.15)",
                  animation: `pulse-skeleton 1.5s ease-in-out ${i * 0.1}s infinite`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom tagline */}
      <p
        className="animate-fade-up delay-600"
        style={{
          position: "fixed", bottom: "16px", fontSize: "11px",
          color: "rgba(240, 240, 245, 0.2)", letterSpacing: "0.1em",
          textTransform: "uppercase", zIndex: 1,
        }}
      >
        Face recognition runs entirely in your browser · No data leaves your device
      </p>

      <style>{`
        @keyframes pulse-skeleton {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
        @keyframes face-pop-in {
          from { opacity: 0; transform: scale(0.6); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </main>
  );
}

// ── Face Card Component ──────────────────────────────────────────────────────
function FaceCard({
  cluster,
  idx,
  onClick,
}: {
  cluster: FaceCluster;
  idx: number;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        width: "90px",
        height: "90px",
        borderRadius: "50%",
        border: hovered
          ? "3px solid #a78bfa"
          : "2px solid rgba(124,58,237,0.35)",
        overflow: "hidden",
        cursor: "pointer",
        background: "#0f0f18",
        padding: 0,
        animation: `face-pop-in 0.4s ease ${idx * 0.04}s both`,
        transform: hovered ? "scale(1.12) translateY(-4px)" : "scale(1)",
        boxShadow: hovered
          ? "0 8px 32px rgba(124,58,237,0.5), 0 0 0 4px rgba(124,58,237,0.12)"
          : "0 2px 12px rgba(0,0,0,0.4)",
        transition:
          "transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease, border 0.2s ease",
        flexShrink: 0,
      }}
      aria-label={`Find photos of person ${idx + 1}`}
      title="Click to find all photos of this person"
    >
      {/*
        Use the pre-rendered canvas crop data URL instead of trying to
        CSS-crop a full-resolution image.  This gives a pixel-perfect,
        centred face that always fills the circle clearly.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cluster.cropDataUrl}
        alt={`Face ${idx + 1}`}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
        }}
      />

      {/* Hover overlay */}
      {hovered && (
        <div style={{
          position: "absolute", inset: 0,
          background: "rgba(124,58,237,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "fade-in 0.15s ease",
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24"
            fill="none" stroke="white" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
      )}

      {/* Person number badge */}
      <div style={{
        position: "absolute", bottom: "-2px", right: "-2px",
        width: "22px", height: "22px", borderRadius: "50%",
        background: "linear-gradient(135deg, #7c3aed, #a78bfa)",
        border: "2px solid #0a0a0f",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "9px", fontWeight: 800, color: "white", lineHeight: 1,
      }}>
        {idx + 1}
      </div>
    </button>
  );
}
