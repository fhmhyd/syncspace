import type { RoomState } from "@/lib/rooms";

export type RoomErrorPayload = {
  code: string;
  message: string;
};

export type PlaybackPayload = {
  roomId: string;
  clientId: string;
  currentTimeSeconds: number;
};

export type VideoSetPayload = {
  roomId: string;
  clientId: string;
  videoId: string;
};

export type ChatMessagePayload = {
  roomId: string;
  clientId: string;
  body: string;
};

export type ChatReadPayload = {
  roomId: string;
  clientId: string;
  messageId?: string;
};

export type ChatTypingPayload = {
  roomId: string;
  clientId: string;
  isTyping: boolean;
};

export type JoinPayload = {
  roomId: string;
  clientId: string;
  userId?: string;
  displayName?: string;
  image?: string | null;
};

export type RoomStatePayload = RoomState & {
  syncedBy?: string;
  participantEvent?: {
    action: "joined" | "left" | "updated";
    name: string;
  };
  syncEvent?:
    | "video:set"
    | "playback:play"
    | "playback:pause"
    | "playback:seek"
    | "participant:update"
    | "room:heartbeat"
    | "chat:message"
    | "chat:read"
    | "chat:typing";
};
