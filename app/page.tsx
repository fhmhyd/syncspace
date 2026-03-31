import { auth } from "@/auth";
import HomeClient from "@/components/home-client";
import { getProfileNameFromCookieStore } from "@/lib/profile";
import { getRoomStore } from "@/lib/rooms";
import { cookies } from "next/headers";

export default async function HomePage({
  searchParams
}: {
  searchParams?: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  const cookieStore = await cookies();
  const params = searchParams ? await searchParams : undefined;
  const callbackUrl = params?.callbackUrl ?? "/";

  const viewer = session?.user
    ? {
        id: session.user.id,
        email: session.user.email,
        image: session.user.image,
        googleName: session.user.googleName,
        displayName: getProfileNameFromCookieStore(
          cookieStore,
          session.user.id,
          session.user.googleName
        )
      }
    : null;

  return (
    <HomeClient
      callbackUrl={callbackUrl}
      viewer={viewer}
      initialRooms={await getRoomStore().getRooms()}
    />
  );
}
