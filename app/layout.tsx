import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Find Your Photos — AI Face Recognition",
  description:
    "Take a selfie and instantly find all your photos from the event using AI face recognition.",
  keywords: ["face recognition", "event photos", "AI photo finder", "selfie"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="noise-overlay mesh-bg">{children}</body>
    </html>
  );
}
