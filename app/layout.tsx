import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Synctype",
  description: "A focused online typing speed check."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
