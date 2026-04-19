import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-runtime",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-runtime",
  display: "swap",
});

export const metadata: Metadata = {
  title: "memory-bench · one table, five architectures, one SQL",
  description:
    "Five agent-memory architectures, one hybrid SQL retriever, one TiDB table. Switch the approach column. Run the retriever. That's the comparison.",
  metadataBase: new URL("https://sonzai-tidb.vercel.app"),
  openGraph: {
    title: "memory-bench · one table, five architectures, one SQL",
    description:
      "Five agent-memory architectures, one hybrid SQL retriever, one TiDB table. Switch the approach column. Run the retriever.",
    url: "https://sonzai-tidb.vercel.app",
    siteName: "memory-bench",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
