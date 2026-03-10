"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface MatchedPhoto {
  filename: string;
  url: string;
  distance: number;
  similarity: number;
  confidence: number;
}

interface CachedDescriptor {
  filename: string;
  descriptors: number[][];  // one per detected face
}

type Status = "loading" | "matching" | "done" | "no-match" | "error";

// ── IndexedDB cache helpers ────────────────────────────────────────────────
const DB_NAME = "photo-finder-cache";
const DB_VERSION = 2;
const STORE = "descriptors";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "filename" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(db: IDBDatabase, filename: string): Promise<CachedDescriptor | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(filename);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function putCached(db: IDBDatabase, entry: CachedDescriptor): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ── Main component ──────────────────────────────────────────────────────────
export default function ResultsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [statusMsg, setStatusMsg] = useState("Loading AI models...");
  const [matches, setMatches] = useState<MatchedPhoto[]>([]);
  const [selfieImg, setSelfieImg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [lightbox, setLightbox] = useState<MatchedPhoto | null>(null);
  const [cacheHits, setCacheHits] = useState(0);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [threshold, setThreshold] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);
  const matchesRef = useRef<MatchedPhoto[]>([]);
  const faceapiRef = useRef<typeof import("face-api.js") | null>(null);

  /** Try SSD first (highest accuracy), fall back to TinyFaceDetector */
  const detectAllFacesHighAccuracy = useCallback(
    async (
      faceapi: typeof import("face-api.js"),
      img: HTMLImageElement
    ) => {
      // Strategy 1: SSD MobileNet v1 + full 68-point landmarks (best accuracy)
      try {
        const dets = await faceapi
          .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks()       // full 68-point model
          .withFaceDescriptors();
        if (dets.length > 0) return { dets, strategy: "ssd+full" };
      } catch { /* SSD not available */ }

      // Strategy 2: SSD + tiny landmarks
      try {
        const dets = await faceapi
          .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 }))
          .withFaceLandmarks(true)
          .withFaceDescriptors();
        if (dets.length > 0) return { dets, strategy: "ssd+tiny" };
      } catch { /* fall through */ }

      // Strategy 3: TinyFaceDetector at larger input (fallback)
      const dets = await faceapi
        .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 }))
        .withFaceLandmarks(true)
        .withFaceDescriptors();
      return { dets, strategy: "tiny" };
    },
    []
  );

  /** Compute a confidence-adjusted similarity score (0-100) */
  const computeSimilarity = useCallback(
    (distance: number, thresh: number, detScore?: number): number => {
      const base = Math.max(0, 1 - distance / thresh) * 100;
      // Boost slightly when detection confidence is high
      const boost = detScore ? Math.min(5, detScore * 5) : 0;
      return Math.round(Math.min(100, base + boost));
    },
    []
  );

  /** Process a single photo: returns descriptors (from cache or detection) */
  const processPhoto = useCallback(
    async (
      faceapi: typeof import("face-api.js"),
      db: IDBDatabase | null,
      filename: string
    ): Promise<{ filename: string; descriptors: number[][]; fromCache: boolean }> => {
      // 1. Try cache first
      if (db) {
        const cached = await getCached(db, filename);
        if (cached) {
          return { filename, descriptors: cached.descriptors, fromCache: true };
        }
      }

      // 2. Load image and detect faces
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `/photos/${filename}`;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load ${filename}`));
        setTimeout(() => reject(new Error("timeout")), 12000);
      });

      const { dets } = await detectAllFacesHighAccuracy(faceapi, img);
      const descriptors = dets.map((d) => Array.from(d.descriptor));

      // Cache for next time
      if (db && descriptors.length > 0) {
        await putCached(db, { filename, descriptors });
      }

      return { filename, descriptors, fromCache: false };
    },
    [detectAllFacesHighAccuracy]
  );

  const runMatching = useCallback(async (thresh?: number) => {
    const effectiveThreshold = thresh ?? threshold;

    try {
      const descriptorJson = sessionStorage.getItem("selfie_descriptor");
      const selfieDataUrl = sessionStorage.getItem("selfie_image");

      if (!descriptorJson) {
        router.push("/camera");
        return;
      }

      setSelfieImg(selfieDataUrl);
      const selfieDescriptor = new Float32Array(JSON.parse(descriptorJson));

      setStatus("matching");
      setStatusMsg("Loading AI models...");
      setProgress(0);
      matchesRef.current = [];
      setMatches([]);

      // Load models (settles even if some fail)
      let faceapi = faceapiRef.current;
      if (!faceapi) {
        faceapi = await import("face-api.js");
        faceapiRef.current = faceapi;
      }
      const MODEL_URL = "/models";
      await Promise.allSettled([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      ]);

      setStatusMsg("Fetching event photos...");
      const res = await fetch("/api/list-photos");
      if (!res.ok) throw new Error("Failed to list photos");
      const { photos } = await res.json() as { photos: string[] };

      if (!photos.length) {
        setStatus("no-match");
        setStatusMsg("No photos found in the gallery.");
        return;
      }

      setTotalPhotos(photos.length);

      // Open descriptor cache DB
      let db: IDBDatabase | null = null;
      try { db = await openDB(); } catch { /* no cache */ }

      let cHits = 0;
      let processed = 0;
      const found: MatchedPhoto[] = [];

      // ── Helper: match descriptors against selfie ──
      const matchDescriptors = (filename: string, descriptors: number[][]) => {
        let bestDistance = Infinity;
        for (const desc of descriptors) {
          const d = faceapi!.euclideanDistance(selfieDescriptor, new Float32Array(desc));
          if (d < bestDistance) bestDistance = d;
        }
        if (bestDistance < effectiveThreshold) {
          const similarity = computeSimilarity(bestDistance, effectiveThreshold);
          found.push({
            filename,
            url: `/photos/${filename}`,
            distance: bestDistance,
            similarity,
            confidence: Math.round((1 - bestDistance) * 100),
          });
          found.sort((a, b) => a.distance - b.distance);
          matchesRef.current = [...found];
          setMatches([...found]);
        }
      };

      // ── PASS 1: Instant cache check (blazing fast) ──
      setStatusMsg("⚡ Checking cached faces...");
      const uncachedPhotos: string[] = [];
      for (const filename of photos) {
        if (db) {
          const cached = await getCached(db, filename);
          if (cached && cached.descriptors.length > 0) {
            cHits++;
            matchDescriptors(filename, cached.descriptors);
            processed++;
            continue;
          }
        }
        uncachedPhotos.push(filename);
      }
      setCacheHits(cHits);
      setProgress(cHits > 0 ? Math.round((processed / photos.length) * 100) : 0);

      if (cHits > 0) {
        setStatusMsg(`⚡ ${cHits} from cache · Scanning ${uncachedPhotos.length} remaining...`);
      }

      // ── PASS 2: Parallel batch processing for uncached (8 at a time) ──
      const BATCH_SIZE = 8;
      for (let i = 0; i < uncachedPhotos.length; i += BATCH_SIZE) {
        const batch = uncachedPhotos.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map((filename) => processPhoto(faceapi!, db, filename))
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            const { filename, descriptors, fromCache } = result.value;
            if (fromCache) cHits++;
            if (descriptors.length > 0) {
              matchDescriptors(filename, descriptors);
            }
          }
          processed++;
        }

        const pct = Math.round((processed / photos.length) * 100);
        setProgress(pct);
        setCacheHits(cHits);
        setStatusMsg(
          `Scanning ${Math.min(processed, photos.length)} / ${photos.length}...` +
          (found.length > 0 ? ` · ${found.length} found` : "")
        );

        // Tiny yield so React can paint the progress updates
        await new Promise((r) => setTimeout(r, 0));
      }

      const finalMatches = [...found].sort((a, b) => a.distance - b.distance);
      setMatches(finalMatches);
      setStatus(finalMatches.length > 0 ? "done" : "no-match");
      setStatusMsg(
        finalMatches.length > 0
          ? `Found ${finalMatches.length} photo${finalMatches.length > 1 ? "s" : ""} of you!`
          : "No matching photos found."
      );
    } catch (err) {
      console.error(err);
      setStatus("error");
      setStatusMsg("Something went wrong. Please try again.");
    }
  }, [router, threshold, detectAllFacesHighAccuracy, computeSimilarity, processPhoto]);

  useEffect(() => {
    runMatching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadPhoto = async (photo: MatchedPhoto) => {
    const link = document.createElement("a");
    link.href = photo.url;
    link.download = photo.filename;
    link.click();
  };

  const downloadAll = () => {
    matches.forEach((p, i) => {
      setTimeout(() => downloadPhoto(p), i * 300);
    });
  };

  const rerunWithThreshold = (newThreshold: number) => {
    setThreshold(newThreshold);
    setShowSettings(false);
    runMatching(newThreshold);
  };

  const getSimilarityColor = (similarity: number) => {
    if (similarity >= 80) return "#10b981";  // green
    if (similarity >= 60) return "#a78bfa";  // purple
    if (similarity >= 40) return "#f59e0b";  // amber
    return "#ef4444";                         // red
  };

  return (
    <main style={{ minHeight: "100vh", padding: "24px", paddingBottom: "80px" }}>
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          maxWidth: "1100px",
          margin: "0 auto 40px",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <button
          onClick={() => router.push("/")}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "50px",
            padding: "10px 20px",
            color: "rgba(240,240,245,0.7)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "14px",
            backdropFilter: "blur(10px)",
            transition: "all 0.2s ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)";
            (e.currentTarget as HTMLButtonElement).style.color = "#fff";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(240,240,245,0.7)";
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Home
        </button>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {/* Threshold settings */}
          {(status === "done" || status === "no-match") && (
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setShowSettings(!showSettings)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "50px",
                  padding: "10px 20px",
                  color: "rgba(240,240,245,0.7)",
                  cursor: "pointer",
                  fontSize: "14px",
                  backdropFilter: "blur(10px)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                ⚙ Accuracy ({Math.round((1 - threshold) * 100)}% strict)
              </button>
              {showSettings && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    background: "#0f0f18",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: "16px",
                    padding: "16px",
                    minWidth: "260px",
                    zIndex: 50,
                    backdropFilter: "blur(20px)",
                    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
                  }}
                >
                  <p style={{ fontSize: "13px", color: "rgba(240,240,245,0.6)", marginBottom: "12px" }}>
                    Match sensitivity — lower = stricter, fewer false positives
                  </p>
                  {[
                    { label: "Very Strict", value: 0.38 },
                    { label: "Strict", value: 0.44 },
                    { label: "Balanced (recommended)", value: 0.50 },
                    { label: "Lenient", value: 0.56 },
                    { label: "Very Lenient", value: 0.62 },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => rerunWithThreshold(opt.value)}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "10px 14px",
                        borderRadius: "10px",
                        background: Math.abs(threshold - opt.value) < 0.01 ? "rgba(124,58,237,0.3)" : "transparent",
                        border: Math.abs(threshold - opt.value) < 0.01 ? "1px solid rgba(124,58,237,0.5)" : "1px solid transparent",
                        color: "rgba(240,240,245,0.8)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: "14px",
                        marginBottom: "4px",
                        transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background =
                          Math.abs(threshold - opt.value) < 0.01 ? "rgba(124,58,237,0.3)" : "transparent";
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {status === "done" && (
            <>
              <button
                onClick={() => router.push("/camera")}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "50px",
                  padding: "10px 20px",
                  color: "rgba(240,240,245,0.7)",
                  cursor: "pointer",
                  fontSize: "14px",
                  backdropFilter: "blur(10px)",
                  transition: "all 0.2s ease",
                }}
              >
                New Selfie
              </button>
              <button
                onClick={downloadAll}
                className="btn-primary"
                style={{ padding: "10px 22px", fontSize: "14px" }}
              >
                ↓ Download All
              </button>
            </>
          )}
        </div>
      </header>

      <div style={{ maxWidth: "1100px", margin: "0 auto" }}>
        {/* Loading / Matching state */}
        {(status === "loading" || status === "matching") && (
          <div
            className="animate-fade-up"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "60vh",
              gap: "32px",
            }}
          >
            {/* Selfie thumbnail */}
            {selfieImg && (
              <div
                style={{
                  width: "100px",
                  height: "100px",
                  borderRadius: "50%",
                  overflow: "hidden",
                  border: "3px solid var(--accent)",
                  boxShadow: "0 0 30px var(--accent-glow)",
                  animation: "pulse-glow 2s ease-in-out infinite",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={selfieImg} alt="Your selfie" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            )}

            {!selfieImg && (
              <div style={{ position: "relative", width: "200px", height: "200px" }}>
                <div
                  style={{
                    width: "200px",
                    height: "200px",
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(124,58,237,0.1) 0%, transparent 70%)",
                    animation: "pulse-glow 2s ease-in-out infinite",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
              </div>
            )}

            <div style={{ textAlign: "center" }}>
              <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "8px" }}>
                {statusMsg}
              </h2>

              {/* Live match count while scanning */}
              {matchesRef.current.length > 0 && (
                <p style={{ color: "#10b981", fontSize: "14px", marginBottom: "8px" }}>
                  ✓ {matchesRef.current.length} match{matchesRef.current.length > 1 ? "es" : ""} found so far…
                </p>
              )}

              {/* Progress bar */}
              {status === "matching" && progress > 0 && (
                <div style={{ marginTop: "20px", width: "360px", maxWidth: "90vw" }}>
                  <div
                    style={{
                      height: "6px",
                      background: "rgba(255,255,255,0.08)",
                      borderRadius: "3px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${progress}%`,
                        background: "linear-gradient(90deg, #7c3aed, #a78bfa)",
                        borderRadius: "3px",
                        transition: "width 0.2s ease",
                        boxShadow: "0 0 10px rgba(167,139,250,0.5)",
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
                    <p style={{ fontSize: "13px", color: "rgba(240,240,245,0.4)" }}>
                      {progress}% complete
                    </p>
                    {cacheHits > 0 && (
                      <p style={{ fontSize: "13px", color: "rgba(167,139,250,0.6)" }}>
                        ⚡ {cacheHits} cached
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Live preview of matches while scanning */}
            {matchesRef.current.length > 0 && (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: "10px",
                maxWidth: "600px",
                width: "100%",
                opacity: 0.7,
              }}>
                {matchesRef.current.slice(0, 6).map((photo) => (
                  <div
                    key={photo.filename}
                    style={{
                      borderRadius: "12px",
                      overflow: "hidden",
                      border: "1px solid rgba(124,58,237,0.3)",
                      aspectRatio: "1",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.url}
                      alt={photo.filename}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {status === "done" && (
          <div className="animate-fade-up">
            {/* Stats bar */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "40px", flexWrap: "wrap" }}>
              {selfieImg && (
                <div
                  style={{
                    width: "56px",
                    height: "56px",
                    borderRadius: "50%",
                    overflow: "hidden",
                    border: "2px solid var(--accent)",
                    flexShrink: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={selfieImg} alt="You" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              )}
              <div>
                <h1 className="gradient-text-white" style={{ fontSize: "32px", fontWeight: 800, lineHeight: 1.1 }}>
                  {matches.length} Photo{matches.length !== 1 ? "s" : ""} Found
                </h1>
                <p style={{ color: "rgba(240,240,245,0.5)", fontSize: "15px", marginTop: "4px" }}>
                  Sorted by match accuracy · Scanned {totalPhotos} photos
                  {cacheHits > 0 && ` · ⚡ ${cacheHits} from cache`}
                </p>
              </div>

              {/* Best match score badge */}
              {matches[0] && (
                <div
                  style={{
                    marginLeft: "auto",
                    padding: "8px 16px",
                    borderRadius: "50px",
                    background: "rgba(16,185,129,0.12)",
                    border: "1px solid rgba(16,185,129,0.3)",
                    fontSize: "14px",
                    color: "#6ee7b7",
                    fontWeight: 600,
                  }}
                >
                  Best: {matches[0].similarity}% match
                </div>
              )}
            </div>

            {/* Photo grid */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "20px",
              }}
            >
              {matches.map((photo, idx) => (
                <div
                  key={photo.filename}
                  className="photo-card glass-card animate-fade-up"
                  style={{
                    borderRadius: "20px",
                    overflow: "hidden",
                    animationDelay: `${idx * 0.06}s`,
                    opacity: 0,
                    animationFillMode: "forwards",
                    cursor: "pointer",
                  }}
                  onClick={() => setLightbox(photo)}
                >
                  {/* Image */}
                  <div style={{ position: "relative", aspectRatio: "4/3", overflow: "hidden" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.url}
                      alt={photo.filename}
                      style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.4s ease" }}
                      onMouseEnter={(e) => { (e.target as HTMLImageElement).style.transform = "scale(1.05)"; }}
                      onMouseLeave={(e) => { (e.target as HTMLImageElement).style.transform = "scale(1)"; }}
                    />
                    {/* Rank badge */}
                    {idx < 3 && (
                      <div
                        style={{
                          position: "absolute",
                          top: "10px",
                          right: "10px",
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          background: idx === 0 ? "#f59e0b" : idx === 1 ? "#94a3b8" : "#cd7f32",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "14px",
                          fontWeight: 800,
                          color: "white",
                          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                        }}
                      >
                        {idx + 1}
                      </div>
                    )}
                    {/* Similarity badge */}
                    <div
                      style={{
                        position: "absolute",
                        top: "12px",
                        left: "12px",
                        padding: "4px 10px",
                        borderRadius: "50px",
                        background: "rgba(0,0,0,0.65)",
                        backdropFilter: "blur(8px)",
                        fontSize: "12px",
                        fontWeight: 700,
                        color: getSimilarityColor(photo.similarity),
                        border: `1px solid ${getSimilarityColor(photo.similarity)}44`,
                      }}
                    >
                      {photo.similarity}% match
                    </div>
                  </div>

                  {/* Card footer */}
                  <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <div style={{ overflow: "hidden" }}>
                      <p style={{ fontSize: "13px", color: "rgba(240,240,245,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {photo.filename}
                      </p>
                      {/* Confidence bar */}
                      <div style={{ marginTop: "6px", height: "3px", background: "rgba(255,255,255,0.08)", borderRadius: "2px", overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${photo.similarity}%`,
                          background: `linear-gradient(90deg, ${getSimilarityColor(photo.similarity)}, ${getSimilarityColor(photo.similarity)}88)`,
                          borderRadius: "2px",
                        }} />
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); downloadPhoto(photo); }}
                      style={{
                        background: "rgba(124,58,237,0.2)",
                        border: "1px solid rgba(124,58,237,0.4)",
                        borderRadius: "50%",
                        width: "36px",
                        height: "36px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        flexShrink: 0,
                        transition: "all 0.2s ease",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(124,58,237,0.4)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(124,58,237,0.2)"; }}
                      aria-label="Download photo"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No match */}
        {status === "no-match" && (
          <div
            className="animate-fade-up"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "60vh",
              gap: "20px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "100px",
                height: "100px",
                borderRadius: "50%",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "44px",
              }}
            >
              🔍
            </div>
            <h2 style={{ fontSize: "28px", fontWeight: 700 }}>No matches found</h2>
            <p style={{ color: "rgba(240,240,245,0.5)", maxWidth: "420px", lineHeight: 1.6 }}>
              We couldn&apos;t find any photos matching your face. Try adjusting the
              <strong style={{ color: "#a78bfa" }}> accuracy settings</strong> above,
              or take a clearer selfie with better lighting.
            </p>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
              <button
                onClick={() => rerunWithThreshold(threshold + 0.06)}
                style={{
                  padding: "14px 28px",
                  borderRadius: "50px",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "rgba(240,240,245,0.8)",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Try More Lenient
              </button>
              <button
                className="btn-primary"
                onClick={() => router.push("/camera")}
                style={{ padding: "14px 28px", fontSize: "14px", marginTop: "0" }}
              >
                New Selfie
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div
            className="animate-fade-up"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "60vh",
              gap: "20px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "48px" }}>⚠️</div>
            <h2 style={{ fontSize: "24px", fontWeight: 700 }}>{statusMsg}</h2>
            <button
              className="btn-primary"
              onClick={() => runMatching()}
              style={{ padding: "16px 36px", fontSize: "15px" }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.88)",
            backdropFilter: "blur(20px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: "24px",
            animation: "fade-in 0.2s ease",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0f0f18",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "24px",
              overflow: "hidden",
              maxWidth: "90vw",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              animation: "scale-in 0.25s ease",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt={lightbox.filename}
              style={{ maxWidth: "80vw", maxHeight: "75vh", objectFit: "contain" }}
            />
            <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
              <div>
                <p style={{ fontWeight: 600, marginBottom: "2px" }}>{lightbox.filename}</p>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "13px", color: getSimilarityColor(lightbox.similarity), fontWeight: 600 }}>
                    {lightbox.similarity}% match
                  </span>
                  <div style={{ height: "3px", width: "80px", background: "rgba(255,255,255,0.08)", borderRadius: "2px", overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${lightbox.similarity}%`,
                      background: getSimilarityColor(lightbox.similarity),
                      borderRadius: "2px",
                    }} />
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => downloadPhoto(lightbox)}
                  className="btn-primary"
                  style={{ padding: "10px 22px", fontSize: "14px" }}
                >
                  Download
                </button>
                <button
                  onClick={() => setLightbox(null)}
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "50px",
                    padding: "10px 22px",
                    color: "rgba(240,240,245,0.7)",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
