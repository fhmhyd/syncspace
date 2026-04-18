import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function SpacesPage() {
  const session = await getServerSession(authOptions);

  return (
    <main className="landing-shell">
      <div className="landing-noise" />
      <header className="landing-header">SYNCSPACE</header>
      <section className="hero-stage">
        <div className="hero-content hero-content-connected">
          <div className="profile-name-pill">{session?.user?.name ?? "Spotify user"}</div>
          <p className="hero-caption">
            spotify account connected. next we can build the room and realtime friend activity flow here.
          </p>
          <Link href="/" className="continue-button">
            Back
          </Link>
        </div>
      </section>
    </main>
  );
}
