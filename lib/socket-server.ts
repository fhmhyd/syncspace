import type { Server as HTTPServer } from "http";
import { getToken } from "next-auth/jwt";
import type { NextApiRequest } from "next";
import { Server as IOServer } from "socket.io";
import { getRoomStore, RoomError, type RoomState } from "@/lib/rooms";
import { getProfileNameFromCookieHeader } from "@/lib/profile";
import type {
  ChatMessagePayload,
  ChatReadPayload,
  ChatTypingPayload,
  JoinPayload,
  PlaybackPayload,
  RoomErrorPayload,
  RoomStatePayload,
  VideoSetPayload
} from "@/lib/socket-types";

declare global {
  var __syncScreenIO: IOServer | undefined;
}

function toPublicState(state: RoomState): RoomStatePayload {
  return {
    roomId: state.roomId,
    title: state.title,
    ownerName: state.ownerName,
    ownerUserId: state.ownerUserId,
    ownerClientId: state.ownerClientId,
    videoId: state.videoId,
    playbackState: state.playbackState,
    currentTimeSeconds: state.currentTimeSeconds,
    updatedAt: state.updatedAt,
    createdAt: state.createdAt,
    participants: state.participants,
    chatMessages: state.chatMessages,
    typingParticipants: state.typingParticipants
  };
}

const LEAVE_GRACE_MS = 3500;

export function getSocketServer(server: HTTPServer): IOServer {
  if (global.__syncScreenIO) {
    return global.__syncScreenIO;
  }

  const roomStore = getRoomStore();
  const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
  const io = new IOServer(server, {
    path: "/api/socket/io",
    addTrailingSlash: false,
    cors: { origin: "*" }
  });

  io.on("connection", (socket) => {
    socket.on("room:join", async (payload: JoinPayload) => {
      try {
        const viewer = await getSocketViewer(socket.handshake.headers.cookie, payload);
        if (!viewer) {
          socket.emit("room:error", {
            code: "UNAUTHORIZED",
            message: "You need to sign in with Google before joining a room."
          } satisfies RoomErrorPayload);
          return;
        }

        const leaveKey = `${payload.roomId}:${payload.clientId}`;
        const pendingLeave = pendingLeaves.get(leaveKey);
        if (pendingLeave) {
          clearTimeout(pendingLeave);
          pendingLeaves.delete(leaveKey);
        }

        const previousRoom = roomStore.getRoom(payload.roomId);
        const previousParticipant = previousRoom?.participants.find(
          (entry) => entry.clientId === payload.clientId
        );

        socket.data.clientId = payload.clientId;
        const room = roomStore.joinRoom(payload.roomId, {
          clientId: payload.clientId,
          name: viewer.displayName,
          image: viewer.image,
          socketId: socket.id,
          joinedAt: Date.now()
        });

        socket.join(payload.roomId);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          participantEvent: {
            action: previousParticipant ? "updated" : "joined",
            name: viewer.displayName
          },
          syncEvent: "participant:update"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("video:set", (payload: VideoSetPayload) => {
      try {
        const room = roomStore.updateVideo(payload.roomId, payload.clientId, payload.videoId);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "video:set"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("playback:play", (payload: PlaybackPayload) => {
      try {
        const room = roomStore.play(payload.roomId, payload.clientId, payload.currentTimeSeconds);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "playback:play"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("playback:pause", (payload: PlaybackPayload) => {
      try {
        const room = roomStore.pause(payload.roomId, payload.clientId, payload.currentTimeSeconds);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "playback:pause"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("playback:seek", (payload: PlaybackPayload) => {
      try {
        const room = roomStore.seek(payload.roomId, payload.clientId, payload.currentTimeSeconds);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "playback:seek"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("chat:message", (payload: ChatMessagePayload) => {
      try {
        const room = roomStore.addChatMessage(payload.roomId, payload.clientId, payload.body);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "chat:message"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("chat:read", (payload: ChatReadPayload) => {
      try {
        const room = roomStore.markChatRead(payload.roomId, payload.clientId, payload.messageId);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "chat:read"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("chat:typing", (payload: ChatTypingPayload) => {
      try {
        const room = roomStore.setTyping(payload.roomId, payload.clientId, payload.isTyping);
        io.to(payload.roomId).emit("room:state", {
          ...toPublicState(room),
          syncedBy: payload.clientId,
          syncEvent: "chat:typing"
        } satisfies RoomStatePayload);
      } catch (error) {
        emitRoomError(socket, error);
      }
    });

    socket.on("disconnecting", () => {
      const clientId = typeof socket.data.clientId === "string" ? socket.data.clientId : null;
      if (!clientId) {
        return;
      }

      for (const roomId of socket.rooms) {
        if (roomId === socket.id) {
          continue;
        }

        const roomBeforeLeave = roomStore.getRoom(roomId);
        const participant = roomBeforeLeave?.participants.find((entry) => entry.clientId === clientId);
        const leaveKey = `${roomId}:${clientId}`;
        const existingTimeout = pendingLeaves.get(leaveKey);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        const leaveTimeout = setTimeout(() => {
          pendingLeaves.delete(leaveKey);

          const currentRoom = roomStore.getRoom(roomId);
          const currentParticipant = currentRoom?.participants.find((entry) => entry.clientId === clientId);
          if (!currentParticipant || currentParticipant.socketId !== socket.id) {
            return;
          }

          const nextRoom = roomStore.leaveRoom(roomId, clientId);
          if (nextRoom) {
            io.to(roomId).emit("room:state", {
              ...toPublicState(nextRoom),
              syncedBy: clientId,
              participantEvent: participant
                ? {
                    action: "left",
                    name: participant.name
                  }
                : undefined,
              syncEvent: "participant:update"
            } satisfies RoomStatePayload);
          }
        }, LEAVE_GRACE_MS);

        pendingLeaves.set(leaveKey, leaveTimeout);
      }
    });
  });

  global.__syncScreenIO = io;
  return io;
}

async function getSocketViewer(cookieHeader: string | undefined, payload: JoinPayload) {
  const token = await getToken({
    req: {
      headers: {
        cookie: cookieHeader ?? ""
      },
      cookies: {}
    } as unknown as NextApiRequest,
    secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
    secureCookie: false
  });

  if (token?.sub) {
    return {
      userId: token.sub,
      displayName: getProfileNameFromCookieHeader(
        cookieHeader,
        token.sub,
        typeof token.googleName === "string"
          ? token.googleName
          : typeof token.name === "string"
            ? token.name
            : ""
      ),
      image: typeof token.picture === "string" ? token.picture : null
    };
  }

  const fallbackUserId = payload.userId?.trim();
  const fallbackName = payload.displayName?.trim();
  if (!fallbackUserId || !fallbackName) {
    return null;
  }

  return {
    userId: fallbackUserId,
    displayName: fallbackName,
    image: payload.image ?? null
  };
}

function emitRoomError(
  socket: { emit: (event: string, payload: RoomErrorPayload) => void },
  error: unknown
) {
  if (error instanceof RoomError) {
    socket.emit("room:error", { code: error.code, message: error.message });
    return;
  }

  socket.emit("room:error", {
    code: "UNKNOWN_ERROR",
    message: "The room action failed."
  });
}
