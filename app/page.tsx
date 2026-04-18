import Image from "next/image";
import Link from "next/link";
import { getServerSession } from "next-auth";
import SyncButton from "@/components/sync-button";
import { authOptions } from "@/lib/auth";

function SpotifyMark() {
  return (
    <svg viewBox="0 0 168 168" aria-hidden="true" className="spotify-mark">
      <circle cx="84" cy="84" r="84" fill="#1ED760" />
      <path
        d="M121.53 115.63a5.24 5.24 0 0 1-7.21 1.73c-19.76-12.07-44.65-14.8-74-8.13a5.24 5.24 0 0 1-2.32-10.22c32.17-7.31 59.77-4.23 81.77 9.21a5.25 5.25 0 0 1 1.76 7.41Z"
        fill="#121212"
      />
      <path
        d="M131.83 92.72a6.56 6.56 0 0 1-9.03 2.15c-22.62-13.9-57.06-17.94-83.82-9.82a6.56 6.56 0 1 1-3.81-12.56c30.54-9.25 68.62-4.74 94.5 11.15a6.56 6.56 0 0 1 2.16 9.08Z"
        fill="#121212"
      />
      <path
        d="M132.73 68.81C105.82 52.83 61.46 51.37 35.77 59.17a7.87 7.87 0 1 1-4.57-15.07c29.48-8.95 78.48-7.22 109.54 11.23a7.87 7.87 0 0 1-8.01 13.48Z"
        fill="#121212"
      />
    </svg>
  );
}

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  const isConnected = Boolean(session?.user);
  const profileName = session?.user?.name ?? "Spotify user";
  const profileImage = session?.user?.image ?? null;

  return (
    <main className="landing-shell">
      <div className="landing-noise" />
      <header className="landing-header">SYNCSPACE</header>
      <section className="hero-stage">
        {isConnected ? (
          <div className="hero-content hero-content-connected">
            <div className="profile-orb" aria-hidden="true">
              {profileImage ? (
                <Image
                  src={profileImage}
                  alt={`${profileName} Spotify profile`}
                  fill
                  sizes="120px"
                  className="profile-orb-image"
                  unoptimized
                />
              ) : (
                <span className="profile-orb-fallback">{profileName.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="profile-name-pill">{profileName}</div>
            <Link href="/spaces" className="continue-button">
              Continue
            </Link>
            <p className="hero-caption">connect your spotify account to create account on syncspace</p>
          </div>
        ) : (
          <div className="hero-content">
            <SpotifyMark />
            <SyncButton />
            <p className="hero-caption">connect your spotify account to create account on syncspace</p>
          </div>
        )}
      </section>
    </main>
  );
}
