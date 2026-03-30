import type { Metadata } from "next";
import Providers from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SyncScreen",
  description: "Two-person synchronized YouTube watch rooms."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
