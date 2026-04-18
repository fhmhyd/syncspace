import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SyncSpace",
  description: "Connect Spotify and start syncing together."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
