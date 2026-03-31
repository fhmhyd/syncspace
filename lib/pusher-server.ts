import Pusher from "pusher";
import type { RoomState } from "./rooms";
import type { RoomStatePayload } from "./socket-types";

// Ensure Pusher is only initialized once in dev
const globalForPusher = global as unknown as { pusher: Pusher };

export const pusherServer =
  globalForPusher.pusher ||
  new Pusher({
    appId: process.env.PUSHER_APP_ID || "",
    key: process.env.PUSHER_KEY || "",
    secret: process.env.PUSHER_SECRET || "",
    cluster: process.env.PUSHER_CLUSTER || "us2",
    useTLS: true,
  });

if (process.env.NODE_ENV !== "production") globalForPusher.pusher = pusherServer;

type BroadcastRoomEventData = Omit<RoomStatePayload, keyof RoomState>;

export async function broadcastRoomState(
  roomId: string,
  state: RoomState,
  eventData: BroadcastRoomEventData = {}
) {
  // Strip potentially large lists if needed, but for small rooms full state is fine
  await pusherServer.trigger(`room-${roomId}`, "room:state", {
    state,
    ...eventData
  });
}

export async function broadcastError(roomId: string, message: string, code: string = "UNKNOWN_ERROR") {
  await pusherServer.trigger(`room-${roomId}`, "room:error", { message, code });
}
