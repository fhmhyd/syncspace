import { NextResponse } from "next/server";
import { getRoomStore, RoomError } from "@/lib/rooms";
import { broadcastRoomState } from "@/lib/pusher-server";
import { auth } from "@/auth";
import type { JoinPayload } from "@/lib/socket-types";

type RoomActionRequestBody = {
  action: string;
  clientId?: string;
  displayName?: string;
  image?: string | null;
  videoId?: string;
  currentTimeSeconds?: number;
  body?: string;
  messageId?: string;
  isTyping?: boolean;
};

function validateActionNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RoomError("INVALID_ROOM_MEMBER", "A valid playback time is required.");
  }
  return value;
}

function validateActionString(value: string | undefined, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RoomError("INVALID_ROOM_MEMBER", message);
  }
  return value;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params;
  const session = await auth();
  
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { action, ...actionData } = payload as RoomActionRequestBody;
  const store = getRoomStore();

  try {
    let nextState;
    const clientId = actionData.clientId;

    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId" }, { status: 400 });
    }

    switch (action) {
      case "room:join": {
        // We use NextAuth session directly if signed in
        if (!session?.user) {
          return NextResponse.json({ code: "UNAUTHORIZED", message: "You need to sign in with Google before joining a room." }, { status: 401 });
        }
        
        const previousRoom = await store.getRoom(roomId);
        const previousParticipant = previousRoom?.participants.find((p) => p.clientId === clientId);
        const joinPayload: JoinPayload = {
          roomId,
          clientId,
          displayName: actionData.displayName,
          image: actionData.image ?? session.user.image ?? null
        };
        
        nextState = await store.joinRoom(roomId, {
          clientId: joinPayload.clientId,
          name:
            joinPayload.displayName || session.user.googleName || session.user.name || "Guest",
          image: joinPayload.image,
          socketId: clientId, // reusing client id
          joinedAt: Date.now()
        });
        
        await broadcastRoomState(roomId, nextState, {
          syncedBy: clientId,
          participantEvent: {
            action: previousParticipant ? "updated" : "joined",
            name: actionData.displayName || session.user.googleName
          },
          syncEvent: "participant:update"
        });
        break;
      }
      case "room:leave": {
        const roomBefore = await store.getRoom(roomId);
        const participant = roomBefore?.participants.find((p) => p.clientId === clientId);
        nextState = await store.leaveRoom(roomId, clientId);
        if (nextState) {
          await broadcastRoomState(roomId, nextState, {
            syncedBy: clientId,
            participantEvent: participant ? { action: "left", name: participant.name } : undefined,
            syncEvent: "participant:update"
          });
        }
        break;
      }
      case "video:set":
        nextState = await store.updateVideo(
          roomId,
          clientId,
          validateActionString(actionData.videoId, "A video ID is required.")
        );
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "video:set" });
        break;
      case "playback:play":
        nextState = await store.play(
          roomId,
          clientId,
          validateActionNumber(actionData.currentTimeSeconds)
        );
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "playback:play" });
        break;
      case "playback:pause":
        nextState = await store.pause(
          roomId,
          clientId,
          validateActionNumber(actionData.currentTimeSeconds)
        );
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "playback:pause" });
        break;
      case "playback:seek":
        nextState = await store.seek(
          roomId,
          clientId,
          validateActionNumber(actionData.currentTimeSeconds)
        );
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "playback:seek" });
        break;
      case "chat:message":
        nextState = await store.addChatMessage(
          roomId,
          clientId,
          validateActionString(actionData.body, "A message cannot be empty.")
        );
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "chat:message" });
        break;
      case "chat:read":
        nextState = await store.markChatRead(roomId, clientId, actionData.messageId);
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "chat:read" });
        break;
      case "chat:typing":
        if (typeof actionData.isTyping !== "boolean") {
          throw new RoomError("INVALID_ROOM_MEMBER", "Typing state must be a boolean.");
        }
        nextState = await store.setTyping(roomId, clientId, actionData.isTyping);
        await broadcastRoomState(roomId, nextState, { syncedBy: clientId, syncEvent: "chat:typing" });
        break;
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    return NextResponse.json({ success: true, state: nextState });

  } catch (error) {
    if (error instanceof RoomError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 400 });
    }
    console.error(`Socket API error:`, error);
    return NextResponse.json({ code: "UNKNOWN_ERROR", message: "The room action failed." }, { status: 500 });
  }
}
