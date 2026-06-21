import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "비슷한집 — 관심 아파트 유사 단지 추천",
  description: "내 관심 아파트와 가격대가 닮은 단지를 추천해드립니다",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
