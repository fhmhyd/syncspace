import { randomUUID } from "crypto";
import { kv } from "@vercel/kv";

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

const ROOM_PREFIX = "syncscreen:room:";
const ROOMS_SET_KEY = "syncscreen:active_rooms";

const useKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

interface KvLike {
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  get<T>(key: string): Promise<T | null>;
  del(key: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
}

class MemoryKv implements KvLike {
  private readonly map = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async sadd(key: string, member: string): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
  }

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }
}

const kvStore: KvLike = useKv ? kv : new MemoryKv();

export class RoomStore {
  async createRoom(input: { title: string; ownerName: string; ownerUserId: string }): Promise<RoomState> {
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

    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: 60 * 60 * 24 });
    await kvStore.sadd(ROOMS_SET_KEY, roomId);
    return room;
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const room = await kvStore.get<RoomState>(`${ROOM_PREFIX}${roomId}`);
    return room ?? null;
  }

  async getRooms(): Promise<RoomSummary[]> {
    const roomIds = await kvStore.smembers(ROOMS_SET_KEY);
    if (!roomIds || roomIds.length === 0) {
      return [];
    }

    const rooms = await Promise.all(
      roomIds.map((id) => kvStore.get<RoomState>(`${ROOM_PREFIX}${id}`))
    );
    const activeRooms = rooms.filter((room): room is RoomState => room !== null);

    return activeRooms
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((room) => ({
        roomId: room.roomId,
        title: room.title,
        ownerName: room.ownerName,
        ownerUserId: room.ownerUserId,
        updatedAt: room.updatedAt,
        createdAt: room.createdAt,
        participants: room.participants || []
      }));
  }

  private async updateRoom(roomId: string, updater: (room: RoomState) => void): Promise<RoomState> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "This room does not exist or has expired.");
    }
    updater(room);
    room.updatedAt = Date.now();
    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: 60 * 60 * 24 });
    return room;
  }

  async joinRoom(roomId: string, participant: Participant): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
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
        room.participants.push({
          ...participant,
          name: normalizedName
        });
      }
      room.typingParticipants = room.typingParticipants.filter(
        (entry) => entry.clientId !== participant.clientId
      );
      if (!room.ownerClientId) {
        room.ownerClientId = participant.clientId;
      }
    });
  }

  async leaveRoom(roomId: string, clientId: string): Promise<RoomState | null> {
    const room = await this.getRoom(roomId);
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
      await kvStore.del(`${ROOM_PREFIX}${roomId}`);
      await kvStore.srem(ROOMS_SET_KEY, roomId);
      return null;
    }

    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: 60 * 60 * 24 });
    return room;
  }

  async updateVideo(roomId: string, clientId: string, videoId: string): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      room.videoId = videoId;
      room.playbackState = "playing";
      room.currentTimeSeconds = 0;
    });
  }

  async play(roomId: string, clientId: string, currentTimeSeconds: number): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      room.playbackState = "playing";
      room.currentTimeSeconds = clampTime(currentTimeSeconds);
    });
  }

  async pause(roomId: string, clientId: string, currentTimeSeconds: number): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      room.playbackState = "paused";
      room.currentTimeSeconds = clampTime(currentTimeSeconds);
    });
  }

  async seek(roomId: string, clientId: string, currentTimeSeconds: number): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      room.currentTimeSeconds = clampTime(currentTimeSeconds);
    });
  }

  async addChatMessage(roomId: string, clientId: string, body: string): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      const participant = room.participants.find((entry) => entry.clientId === clientId);
      if (!participant) {
        throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
      }

      const normalizedBody = normalizeChatBody(body);
      room.chatMessages.push({
        id: randomUUID(),
        clientId,
        authorName: participant.name,
        authorImage: participant.image ?? null,
        body: normalizedBody,
        sentAt: Date.now(),
        readByClientIds: [clientId]
      });
      room.chatMessages = room.chatMessages.slice(-100);
      room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
    });
  }

  async markChatRead(roomId: string, clientId: string, messageId?: string): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      if (room.chatMessages.length === 0) {
        return;
      }

      const targetIndex = messageId
        ? room.chatMessages.findIndex((message) => message.id === messageId)
        : room.chatMessages.length - 1;

      if (targetIndex < 0) {
        return;
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
    });
  }

  async setTyping(roomId: string, clientId: string, isTyping: boolean): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      const participant = room.participants.find((entry) => entry.clientId === clientId);
      if (!participant) {
        throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
      }

      if (isTyping) {
        const existing = room.typingParticipants.find((entry) => entry.clientId === clientId);
        if (!existing) {
          room.typingParticipants.push({
            clientId,
            name: participant.name
          });
        }
      } else {
        room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
      }
    });
  }

  private requireMember(room: RoomState, clientId: string): void {
    const isMember = (room.participants || []).some((entry) => entry.clientId === clientId);
    if (!isMember) {
      throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
    }
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

// Global instance to prevent multiple instances
declare global {
  var __syncScreenRoomsAsync: RoomStore | undefined;
}

export function getRoomStore(): RoomStore {
  if (!global.__syncScreenRoomsAsync) {
    global.__syncScreenRoomsAsync = new RoomStore();
  }
  return global.__syncScreenRoomsAsync;
}
