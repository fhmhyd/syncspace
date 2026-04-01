import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { pusherServer } from "@/lib/pusher-server";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const socketId = formData.get("socket_id");
  const channelName = formData.get("channel_name");

  if (typeof socketId !== "string" || typeof channelName !== "string") {
    return NextResponse.json({ error: "Invalid Pusher auth payload" }, { status: 400 });
  }

  if (!channelName.startsWith("private-room-")) {
    return NextResponse.json({ error: "Channel not allowed" }, { status: 403 });
  }

  const authResponse = pusherServer.authorizeChannel(socketId, channelName, {
    user_id: session.user.id,
    user_info: {
      name: session.user.name ?? session.user.googleName ?? "Guest"
    }
  });

  return NextResponse.json(authResponse);
}
