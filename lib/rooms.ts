import { randomUUID } from "crypto";

export type PlaybackState = "playing" | "paused";

export type Participant = {
  clientId: string;
  name: string;
  image?: string | null;
  socketId: string;
  joinedAt: number;
};

export type ChatMessage = {
  id: string;
  clientId: string;
  authorName: string;
  authorImage?: string | null;
  body: string;
  sentAt: number;
  readByClientIds: string[];
};

export type TypingParticipant = {
  clientId: string;
  name: string;
};

export type RoomState = {
  roomId: string;
  title: string;
  ownerName: string;
  ownerUserId: string;
  ownerClientId: string | null;
  videoId: string | null;
  playbackState: PlaybackState;
  currentTimeSeconds: number;
  updatedAt: number;
  createdAt: number;
  participants: Participant[];
  chatMessages: ChatMessage[];
  typingParticipants: TypingParticipant[];
};

export type RoomSummary = Pick<
  RoomState,
  "roomId" | "title" | "ownerName" | "ownerUserId" | "updatedAt" | "createdAt" | "participants"
>;

export class RoomError extends Error {
  code: "ROOM_NOT_FOUND" | "ROOM_FULL" | "INVALID_ROOM_MEMBER";

  constructor(
    code: "ROOM_NOT_FOUND" | "ROOM_FULL" | "INVALID_ROOM_MEMBER",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

class RoomStore {
  private readonly rooms = new Map<string, RoomState>();

  createRoom(input: { title: string; ownerName: string; ownerUserId: string }): RoomState {
    const roomId = randomUUID().slice(0, 8);
    const createdAt = Date.now();
    const room: RoomState = {
      roomId,
      title: normalizeRoomTitle(input.title),
      ownerName: normalizeRoomOwner(input.ownerName),
      ownerUserId: input.ownerUserId,
      ownerClientId: null,
      videoId: null,
      playbackState: "paused",
      currentTimeSeconds: 0,
      updatedAt: createdAt,
      createdAt,
      participants: [],
      chatMessages: [],
      typingParticipants: []
    };

    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId: string): RoomState | null {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }

  getRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((room) => ({
        roomId: room.roomId,
        title: room.title,
        ownerName: room.ownerName,
        ownerUserId: room.ownerUserId,
        updatedAt: room.updatedAt,
        createdAt: room.createdAt,
        participants: structuredClone(room.participants)
      }));
  }

  joinRoom(roomId: string, participant: Participant): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "This room does not exist or has expired.");
    }

    const normalizedName = participant.name.trim();
    if (!normalizedName) {
      throw new RoomError("INVALID_ROOM_MEMBER", "A display name is required to join the room.");
    }

    const existing = room.participants.find((entry) => entry.clientId === participant.clientId);
    if (!existing && room.participants.length >= 2) {
      throw new RoomError("ROOM_FULL", "This room already has two participants.");
    }

    if (existing) {
      room.participants = room.participants.map((entry) =>
        entry.clientId === participant.clientId
          ? {
              ...entry,
              socketId: participant.socketId,
              name: normalizedName,
              image: participant.image ?? null
            }
          : entry
      );
    } else {
      room.participants = [
        ...room.participants,
        {
          ...participant,
          name: normalizedName
        }
      ];
    }
    room.typingParticipants = room.typingParticipants.filter(
      (entry) => entry.clientId !== participant.clientId
    );
    if (!room.ownerClientId) {
      room.ownerClientId = participant.clientId;
    }
    room.updatedAt = Date.now();

    return structuredClone(room);
  }

  leaveRoom(roomId: string, clientId: string): RoomState | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }

    room.participants = room.participants.filter((entry) => entry.clientId !== clientId);
    room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
    if (room.ownerClientId === clientId) {
      room.ownerClientId = room.participants[0]?.clientId ?? null;
    }
    room.updatedAt = Date.now();

    if (room.participants.length === 0) {
      this.rooms.delete(roomId);
      return null;
    }

    return structuredClone(room);
  }

  updateVideo(roomId: string, clientId: string, videoId: string): RoomState {
    const room = this.requireMember(roomId, clientId);
    room.videoId = videoId;
    room.playbackState = "playing";
    room.currentTimeSeconds = 0;
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  play(roomId: string, clientId: string, currentTimeSeconds: number): RoomState {
    const room = this.requireMember(roomId, clientId);
    room.playbackState = "playing";
    room.currentTimeSeconds = clampTime(currentTimeSeconds);
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  pause(roomId: string, clientId: string, currentTimeSeconds: number): RoomState {
    const room = this.requireMember(roomId, clientId);
    room.playbackState = "paused";
    room.currentTimeSeconds = clampTime(currentTimeSeconds);
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  seek(roomId: string, clientId: string, currentTimeSeconds: number): RoomState {
    const room = this.requireMember(roomId, clientId);
    room.currentTimeSeconds = clampTime(currentTimeSeconds);
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  addChatMessage(roomId: string, clientId: string, body: string): RoomState {
    const room = this.requireMember(roomId, clientId);
    const participant = room.participants.find((entry) => entry.clientId === clientId);
    if (!participant) {
      throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
    }

    const normalizedBody = normalizeChatBody(body);
    room.chatMessages = [
      ...room.chatMessages,
      {
        id: randomUUID(),
        clientId,
        authorName: participant.name,
        authorImage: participant.image ?? null,
        body: normalizedBody,
        sentAt: Date.now(),
        readByClientIds: [clientId]
      }
    ].slice(-100);
    room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  markChatRead(roomId: string, clientId: string, messageId?: string): RoomState {
    const room = this.requireMember(roomId, clientId);
    if (room.chatMessages.length === 0) {
      return structuredClone(room);
    }

    const targetIndex = messageId
      ? room.chatMessages.findIndex((message) => message.id === messageId)
      : room.chatMessages.length - 1;

    if (targetIndex < 0) {
      return structuredClone(room);
    }

    room.chatMessages = room.chatMessages.map((message, index) => {
      if (index > targetIndex || message.readByClientIds.includes(clientId)) {
        return message;
      }

      return {
        ...message,
        readByClientIds: [...message.readByClientIds, clientId]
      };
    });
    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  setTyping(roomId: string, clientId: string, isTyping: boolean): RoomState {
    const room = this.requireMember(roomId, clientId);
    const participant = room.participants.find((entry) => entry.clientId === clientId);
    if (!participant) {
      throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
    }

    if (isTyping) {
      const existing = room.typingParticipants.find((entry) => entry.clientId === clientId);
      if (!existing) {
        room.typingParticipants = [
          ...room.typingParticipants,
          {
            clientId,
            name: participant.name
          }
        ];
      }
    } else {
      room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
    }

    room.updatedAt = Date.now();
    return structuredClone(room);
  }

  private requireMember(roomId: string, clientId: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "This room does not exist or has expired.");
    }

    const isMember = room.participants.some((entry) => entry.clientId === clientId);
    if (!isMember) {
      throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
    }

    return room;
  }
}

function clampTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Number(value.toFixed(2));
}

function normalizeRoomTitle(value: string): string {
  const trimmed = value.trim().slice(0, 48);
  if (!trimmed) {
    throw new RoomError("INVALID_ROOM_MEMBER", "A room title is required.");
  }

  return trimmed;
}

function normalizeRoomOwner(value: string): string {
  const trimmed = value.trim().slice(0, 32);
  if (!trimmed) {
    throw new RoomError("INVALID_ROOM_MEMBER", "An owner name is required.");
  }

  return trimmed;
}

function normalizeChatBody(value: string): string {
  const trimmed = value.trim().slice(0, 400);
  if (!trimmed) {
    throw new RoomError("INVALID_ROOM_MEMBER", "A message cannot be empty.");
  }

  return trimmed;
}

declare global {
  var __syncScreenRooms: RoomStore | undefined;
}

export function getRoomStore(): RoomStore {
  if (!global.__syncScreenRooms) {
    global.__syncScreenRooms = new RoomStore();
  }

  return global.__syncScreenRooms;
}
