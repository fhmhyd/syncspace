import { auth } from "@/auth";
import WatchRoomClient from "@/components/watch-room-client";
import { getProfileNameFromCookieStore } from "@/lib/profile";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function RoomPage({
  params
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/?callbackUrl=${encodeURIComponent(`/room/${roomId}`)}`);
  }

  const cookieStore = await cookies();
  return (
    <WatchRoomClient
      roomId={roomId}
      viewer={{
        id: session.user.id,
        email: session.user.email,
        image: session.user.image,
        googleName: session.user.googleName,
        displayName: getProfileNameFromCookieStore(
          cookieStore,
          session.user.id,
          session.user.googleName
        )
      }}
    />
  );
}
