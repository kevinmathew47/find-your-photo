"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

type Status =
  | "idle"
  | "loading-models"
  | "ready"
  | "capturing"
  | "processing"
  | "error";

export default function CameraPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState("Initializing...");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturedImg, setCapturedImg] = useState<string | null>(null);
  const [faceDetected, setFaceDetected] = useState(false);
  const [uploadMode, setUploadMode] = useState(false);
  const faceapiRef = useRef<typeof import("face-api.js") | null>(null);
  const detectionLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (detectionLoopRef.current) {
      clearInterval(detectionLoopRef.current);
    }
  }, []);

  /** Run face detection using multiple strategies for best accuracy */
  const detectFaceHighAccuracy = useCallback(
    async (
      faceapi: typeof import("face-api.js"),
      input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
    ) => {
      // Strategy 1: SSD MobileNet (highest accuracy) with full 68-point landmarks
      try {
        const det = await faceapi
          .detectSingleFace(
            input,
            new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
          )
          .withFaceLandmarks()   // full 68-point model
          .withFaceDescriptor();
        if (det) return det;
      } catch {/* SSD not loaded, fall through */ }

      // Strategy 2: SSD with tiny landmarks
      try {
        const det = await faceapi
          .detectSingleFace(
            input,
            new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 })
          )
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if (det) return det;
      } catch {/* fall through */ }

      // Strategy 3: TinyFaceDetector fallback with larger input size
      const det = await faceapi
        .detectSingleFace(
          input,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 })
        )
        .withFaceLandmarks(true)
        .withFaceDescriptor();
      return det ?? null;
    },
    []
  );

  const startFaceDetectionLoop = useCallback(
    (faceapi: typeof import("face-api.js")) => {
      detectionLoopRef.current = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;
        try {
          // Use SSD for live preview detection (more accurate)
          let det = null;
          try {
            det = await faceapi.detectSingleFace(
              videoRef.current,
              new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
            );
          } catch {
            det = await faceapi.detectSingleFace(
              videoRef.current,
              new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
            );
          }
          setFaceDetected(!!det);
        } catch {
          setFaceDetected(false);
        }
      }, 500);
    },
    []
  );

  const loadModels = useCallback(async (faceapi: typeof import("face-api.js")) => {
    const MODEL_URL = "/models";
    const loads: Promise<void>[] = [
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ];
    // Try loading high-accuracy models optionally
    try {
      loads.push(faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL));
    } catch { /* optional */ }
    try {
      loads.push(faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL));
    } catch { /* optional */ }
    await Promise.allSettled(loads);
  }, []);

  const initCamera = useCallback(async () => {
    try {
      setStatus("loading-models");
      setStatusMsg("Loading AI face models...");

      const faceapi = await import("face-api.js");
      faceapiRef.current = faceapi;

      await loadModels(faceapi);

      setStatusMsg("Starting camera...");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setStatus("ready");
      setStatusMsg("Position your face in the frame");
      startFaceDetectionLoop(faceapi);
    } catch (err) {
      console.error(err);
      setStatus("error");
      setStatusMsg(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Camera access denied. Please allow camera permissions."
          : "Failed to initialize camera."
      );
    }
  }, [startFaceDetectionLoop, loadModels]);

  const initUploadMode = useCallback(async () => {
    try {
      setUploadMode(true);
      setStatus("loading-models");
      setStatusMsg("Loading AI face models...");

      const faceapi = await import("face-api.js");
      faceapiRef.current = faceapi;

      await loadModels(faceapi);

      setStatus("ready");
      setStatusMsg("Upload a photo of yourself");
    } catch (err) {
      console.error(err);
      setStatus("error");
      setStatusMsg("Failed to load AI models.");
    }
  }, [loadModels]);

  useEffect(() => {
    initCamera();
    return () => stopStream();
  }, [initCamera, stopStream]);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !faceapiRef.current) return;
    const faceapi = faceapiRef.current;

    // Countdown
    setStatus("capturing");
    for (let i = 3; i >= 1; i--) {
      setCountdown(i);
      await new Promise((r) => setTimeout(r, 900));
    }
    setCountdown(null);

    // Snap frame at full resolution
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0);
    ctx.restore();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    setCapturedImg(dataUrl);
    setStatus("processing");
    setStatusMsg("Detecting face in your selfie...");

    // Detect face in captured image with high accuracy
    const img = new Image();
    img.src = dataUrl;
    await new Promise((r) => (img.onload = r));

    const detection = await detectFaceHighAccuracy(faceapi, img);

    if (!detection) {
      setStatus("ready");
      setCapturedImg(null);
      setStatusMsg("No face detected. Try better lighting or a front-facing angle.");
      return;
    }

    setStatusMsg("Face detected! Searching for matches...");

    const descriptor = Array.from(detection.descriptor);
    sessionStorage.setItem("selfie_descriptor", JSON.stringify(descriptor));
    sessionStorage.setItem("selfie_image", dataUrl);

    stopStream();
    router.push("/results");
  }, [router, stopStream, detectFaceHighAccuracy]);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!faceapiRef.current) return;
    const faceapi = faceapiRef.current;

    setStatus("processing");
    setStatusMsg("Reading your photo...");

    const dataUrl = await new Promise<string>((res) => {
      const reader = new FileReader();
      reader.onload = (e) => res(e.target?.result as string);
      reader.readAsDataURL(file);
    });

    setCapturedImg(dataUrl);
    setStatusMsg("Detecting face in uploaded photo...");

    const img = new Image();
    img.src = dataUrl;
    await new Promise((r) => (img.onload = r));

    const detection = await detectFaceHighAccuracy(faceapi, img);

    if (!detection) {
      setStatus("ready");
      setCapturedImg(null);
      setStatusMsg("No face detected. Please upload a clear front-facing photo.");
      return;
    }

    setStatusMsg("Face detected! Searching for matches...");
    const descriptor = Array.from(detection.descriptor);
    sessionStorage.setItem("selfie_descriptor", JSON.stringify(descriptor));
    sessionStorage.setItem("selfie_image", dataUrl);

    router.push("/results");
  }, [router, detectFaceHighAccuracy]);

  const retake = useCallback(() => {
    setCapturedImg(null);
    setStatus("ready");
    if (!uploadMode) {
      stopStream();
      initCamera();
    } else {
      setStatusMsg("Upload a photo of yourself");
    }
  }, [initCamera, stopStream, uploadMode]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        position: "relative",
      }}
    >
      {/* Back button */}
      <button
        onClick={() => { stopStream(); router.push("/"); }}
        style={{
          position: "fixed",
          top: "24px",
          left: "24px",
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
          zIndex: 10,
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
        Back
      </button>

      {/* Mode toggle */}
      {status !== "capturing" && status !== "processing" && (
        <div
          style={{
            position: "fixed",
            top: "24px",
            right: "24px",
            display: "flex",
            gap: "8px",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => { if (uploadMode) { setUploadMode(false); stopStream(); initCamera(); } }}
            style={{
              padding: "8px 16px",
              borderRadius: "50px",
              background: !uploadMode ? "rgba(124,58,237,0.3)" : "rgba(255,255,255,0.05)",
              border: !uploadMode ? "1px solid rgba(124,58,237,0.6)" : "1px solid rgba(255,255,255,0.1)",
              color: !uploadMode ? "#a78bfa" : "rgba(240,240,245,0.5)",
              cursor: "pointer",
              fontSize: "13px",
              backdropFilter: "blur(10px)",
              transition: "all 0.2s ease",
            }}
          >
            📷 Camera
          </button>
          <button
            onClick={() => { if (!uploadMode) { stopStream(); initUploadMode(); } }}
            style={{
              padding: "8px 16px",
              borderRadius: "50px",
              background: uploadMode ? "rgba(124,58,237,0.3)" : "rgba(255,255,255,0.05)",
              border: uploadMode ? "1px solid rgba(124,58,237,0.6)" : "1px solid rgba(255,255,255,0.1)",
              color: uploadMode ? "#a78bfa" : "rgba(240,240,245,0.5)",
              cursor: "pointer",
              fontSize: "13px",
              backdropFilter: "blur(10px)",
              transition: "all 0.2s ease",
            }}
          >
            📁 Upload
          </button>
        </div>
      )}

      <div style={{ maxWidth: "520px", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "24px" }}>
        {/* Title */}
        <div className="animate-fade-up" style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: "28px", fontWeight: 700, marginBottom: "8px" }}>
            {status === "processing" ? "Analyzing Your Face" : uploadMode ? "Upload Your Photo" : "Take Your Selfie"}
          </h1>
          <p style={{ color: "rgba(240,240,245,0.5)", fontSize: "15px" }}>{statusMsg}</p>
        </div>

        {/* Camera / Upload viewfinder */}
        <div
          className="animate-fade-up delay-100"
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "4/3",
            borderRadius: "24px",
            overflow: "hidden",
            background: "#0a0a0f",
            border: `2px solid ${faceDetected ? "rgba(16, 185, 129, 0.6)" : "rgba(124, 58, 237, 0.4)"}`,
            boxShadow: faceDetected
              ? "0 0 30px rgba(16, 185, 129, 0.2)"
              : "0 0 30px rgba(124, 58, 237, 0.15)",
            transition: "border-color 0.4s ease, box-shadow 0.4s ease",
          }}
        >
          {/* Upload drop zone */}
          {uploadMode && !capturedImg && status === "ready" && (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file && file.type.startsWith("image/")) handleFileUpload(file);
              }}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "16px",
                cursor: "pointer",
                background: "rgba(124,58,237,0.04)",
                transition: "background 0.2s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "rgba(124,58,237,0.1)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "rgba(124,58,237,0.04)";
              }}
            >
              <div style={{
                width: "80px", height: "80px", borderRadius: "50%",
                background: "rgba(124,58,237,0.15)",
                border: "2px dashed rgba(124,58,237,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "32px",
              }}>
                📷
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ color: "#a78bfa", fontWeight: 600, marginBottom: "4px" }}>Click to upload photo</p>
                <p style={{ color: "rgba(240,240,245,0.4)", fontSize: "13px" }}>or drag & drop here</p>
              </div>
            </div>
          )}

          {/* Video feed */}
          {!uploadMode && (
            <video
              ref={videoRef}
              playsInline
              muted
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                transform: "scaleX(-1)",
                display: capturedImg ? "none" : "block",
              }}
            />
          )}

          {/* Captured image preview */}
          {capturedImg && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={capturedImg}
              alt="Captured selfie"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          )}

          {/* Countdown overlay */}
          {countdown !== null && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.4)",
                fontSize: "96px",
                fontWeight: 800,
                color: "white",
                animation: "scale-in 0.3s ease",
              }}
            >
              {countdown}
            </div>
          )}

          {/* Processing overlay */}
          {status === "processing" && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "16px",
              }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  border: "3px solid rgba(124,58,237,0.3)",
                  borderTopColor: "var(--accent-light)",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <p style={{ color: "#a78bfa", fontSize: "14px", fontWeight: 600 }}>{statusMsg}</p>
            </div>
          )}

          {/* Corner decorators */}
          {["top-left", "top-right", "bottom-left", "bottom-right"].map((pos) => (
            <div
              key={pos}
              style={{
                position: "absolute",
                width: "28px",
                height: "28px",
                ...(pos.includes("top") ? { top: "12px" } : { bottom: "12px" }),
                ...(pos.includes("left") ? { left: "12px" } : { right: "12px" }),
                borderTop: pos.includes("top") ? "3px solid var(--accent-light)" : "none",
                borderBottom: pos.includes("bottom") ? "3px solid var(--accent-light)" : "none",
                borderLeft: pos.includes("left") ? "3px solid var(--accent-light)" : "none",
                borderRight: pos.includes("right") ? "3px solid var(--accent-light)" : "none",
                borderTopLeftRadius: pos === "top-left" ? "6px" : undefined,
                borderTopRightRadius: pos === "top-right" ? "6px" : undefined,
                borderBottomLeftRadius: pos === "bottom-left" ? "6px" : undefined,
                borderBottomRightRadius: pos === "bottom-right" ? "6px" : undefined,
                opacity: 0.8,
              }}
            />
          ))}

          {/* Face indicator (camera mode) */}
          {status === "ready" && !uploadMode && (
            <div
              style={{
                position: "absolute",
                bottom: "16px",
                left: "50%",
                transform: "translateX(-50%)",
                padding: "6px 14px",
                borderRadius: "50px",
                background: faceDetected ? "rgba(16,185,129,0.2)" : "rgba(0,0,0,0.4)",
                border: `1px solid ${faceDetected ? "rgba(16,185,129,0.5)" : "rgba(255,255,255,0.15)"}`,
                fontSize: "12px",
                color: faceDetected ? "#6ee7b7" : "rgba(255,255,255,0.5)",
                backdropFilter: "blur(10px)",
                transition: "all 0.3s ease",
                whiteSpace: "nowrap",
              }}
            >
              {faceDetected ? "✓ Face detected" : "No face detected"}
            </div>
          )}

          {/* Loading overlay */}
          {(status === "idle" || status === "loading-models") && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "16px",
                background: "rgba(10,10,15,0.8)",
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  border: "3px solid rgba(124,58,237,0.2)",
                  borderTopColor: "var(--accent-light)",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <p style={{ color: "rgba(240,240,245,0.6)", fontSize: "14px" }}>
                {statusMsg}
              </p>
            </div>
          )}
        </div>

        {/* Hidden canvas & file input */}
        <canvas ref={canvasRef} style={{ display: "none" }} />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileUpload(file);
            e.target.value = "";
          }}
        />

        {/* Action buttons */}
        <div className="animate-fade-up delay-200" style={{ display: "flex", gap: "12px", width: "100%" }}>
          {status === "ready" && !uploadMode && (
            <button
              id="capture-btn"
              className="btn-primary"
              onClick={capturePhoto}
              style={{
                flex: 1,
                padding: "18px",
                fontSize: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              Capture Selfie
            </button>
          )}

          {status === "ready" && uploadMode && (
            <button
              id="upload-btn"
              className="btn-primary"
              onClick={() => fileInputRef.current?.click()}
              style={{
                flex: 1,
                padding: "18px",
                fontSize: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Choose Photo
            </button>
          )}

          {status === "capturing" && (
            <div style={{ flex: 1, textAlign: "center", padding: "18px", color: "var(--accent-light)", fontSize: "16px", fontWeight: 600 }}>
              Get ready…
            </div>
          )}

          {status === "processing" && (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "12px",
                padding: "18px",
                borderRadius: "50px",
                background: "rgba(124,58,237,0.1)",
                border: "1px solid rgba(124,58,237,0.3)",
                color: "var(--accent-light)",
                fontSize: "14px",
              }}
            >
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  border: "2px solid rgba(167,139,250,0.3)",
                  borderTopColor: "var(--accent-light)",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              Analyzing face…
            </div>
          )}

          {(status === "ready" || status === "error") && capturedImg && (
            <button
              onClick={retake}
              style={{
                padding: "18px 24px",
                borderRadius: "50px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(240,240,245,0.7)",
                cursor: "pointer",
                fontSize: "15px",
                transition: "all 0.2s ease",
              }}
            >
              Retake
            </button>
          )}
        </div>

        {status === "error" && !capturedImg && (
          <button
            className="btn-primary"
            onClick={uploadMode ? initUploadMode : initCamera}
            style={{ padding: "16px 40px", fontSize: "15px" }}
          >
            Try Again
          </button>
        )}

        <p style={{ fontSize: "12px", color: "rgba(240,240,245,0.25)", textAlign: "center" }}>
          Your photo never leaves your device · Powered by face-api.js
        </p>
      </div>

      <style jsx global>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}
