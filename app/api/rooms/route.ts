import { auth } from "@/auth";
import { getProfileNameFromCookieStore } from "@/lib/profile";
import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/rooms";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as { title?: string } | null;
  const title = payload?.title?.trim() ?? "";
  if (!title) {
    return NextResponse.json({ error: "A room title is required." }, { status: 400 });
  }

  const cookieStore = await cookies();
  const ownerName = getProfileNameFromCookieStore(
    cookieStore,
    session.user.id,
    session.user.googleName
  );

  const room = await getRoomStore().createRoom({
    title,
    ownerName,
    ownerUserId: session.user.id
  });

  return NextResponse.json(
    {
      roomId: room.roomId,
      title: room.title,
      ownerName: room.ownerName,
      ownerUserId: room.ownerUserId,
      updatedAt: room.updatedAt,
      createdAt: room.createdAt,
      participants: room.participants
    },
    { status: 201 }
  );
}
