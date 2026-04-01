import { randomUUID } from "crypto";
import { kv } from "@vercel/kv";
import { createClient } from "redis";

export type PlaybackState = "playing" | "paused";
export type PlaybackCommand =
  | "video:set"
  | "playback:play"
  | "playback:pause"
  | "playback:seek";
export type PlaybackControlMode = "shared" | "owner";

export type Participant = {
  clientId: string;
  userId: string;
  name: string;
  image?: string | null;
  socketId: string;
  joinedAt: number;
  lastSeenAt: number;
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
  playbackUpdatedAt: number;
  playbackSequence: number;
  playbackCommand: PlaybackCommand | null;
  playbackControlMode: PlaybackControlMode;
  playbackControllerClientId: string | null;
  playbackControllerUserId: string | null;
  playbackControllerName: string | null;
  updatedAt: number;
  createdAt: number;
  emptySinceAt?: number | null;
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
const ROOM_TTL_SECONDS = 60 * 60 * 24;
const PARTICIPANT_STALE_MS = 25_000;
const EMPTY_ROOM_GRACE_MS = 2 * 60_000;

const useKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const useRedisUrl = Boolean(process.env.REDIS_URL);

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

class RedisUrlStore implements KvLike {
  constructor(private readonly client: ReturnType<typeof createClient>) {}

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    const serialized = JSON.stringify(value);
    if (opts?.ex) {
      return this.client.set(key, serialized, { EX: opts.ex });
    }
    return this.client.set(key, serialized);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.sMembers(key);
  }

  async sadd(key: string, member: string): Promise<unknown> {
    return this.client.sAdd(key, member);
  }

  async srem(key: string, member: string): Promise<unknown> {
    return this.client.sRem(key, member);
  }
}

declare global {
  var __syncScreenRoomsAsync: RoomStore | undefined;
  var __syncScreenRedisClient: ReturnType<typeof createClient> | undefined;
  var __syncScreenKvStore: KvLike | undefined;
}

function getRedisClient(): ReturnType<typeof createClient> {
  if (!global.__syncScreenRedisClient) {
    const client = createClient({
      url: process.env.REDIS_URL
    });
    client.on("error", (error) => {
      console.error("Redis client error", error);
    });
    global.__syncScreenRedisClient = client;
  }

  if (!global.__syncScreenRedisClient.isOpen) {
    void global.__syncScreenRedisClient.connect();
  }

  return global.__syncScreenRedisClient;
}

function getKvStore(): KvLike {
  if (!global.__syncScreenKvStore) {
    if (useKv) {
      global.__syncScreenKvStore = kv;
    } else if (useRedisUrl) {
      global.__syncScreenKvStore = new RedisUrlStore(getRedisClient());
    } else {
      global.__syncScreenKvStore = new MemoryKv();
    }
  }

  return global.__syncScreenKvStore;
}

export class RoomStore {
  async createRoom(input: { title: string; ownerName: string; ownerUserId: string }): Promise<RoomState> {
    const kvStore = getKvStore();
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
      playbackUpdatedAt: createdAt,
      playbackSequence: 0,
      playbackCommand: null,
      playbackControlMode: "shared",
      playbackControllerClientId: null,
      playbackControllerUserId: null,
      playbackControllerName: null,
      updatedAt: createdAt,
      createdAt,
      emptySinceAt: null,
      participants: [],
      chatMessages: [],
      typingParticipants: []
    };

    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: ROOM_TTL_SECONDS });
    await kvStore.sadd(ROOMS_SET_KEY, roomId);
    return room;
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const kvStore = getKvStore();
    const storedRoom = await kvStore.get<RoomState>(`${ROOM_PREFIX}${roomId}`);
    if (!storedRoom) {
      return null;
    }
    const room = normalizeRoomState(storedRoom);

    const { room: cleanedRoom, changed, shouldDelete } = cleanupRoomPresence(room);
    if (shouldDelete) {
      await kvStore.del(`${ROOM_PREFIX}${roomId}`);
      await kvStore.srem(ROOMS_SET_KEY, roomId);
      return null;
    }
    if (changed) {
      await kvStore.set(`${ROOM_PREFIX}${roomId}`, cleanedRoom, { ex: ROOM_TTL_SECONDS });
    }

    return cleanedRoom;
  }

  async getRooms(): Promise<RoomSummary[]> {
    const kvStore = getKvStore();
    const roomIds = await kvStore.smembers(ROOMS_SET_KEY);
    if (!roomIds || roomIds.length === 0) {
      return [];
    }

    const rooms = await Promise.all(roomIds.map((id) => this.getRoom(id)));
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

  private async updateRoom(
    roomId: string,
    updater: (room: RoomState) => void,
    options: {
      touchUpdatedAt?: boolean;
      touchPlaybackUpdatedAt?: boolean;
      playbackCommand?: PlaybackCommand;
    } = {}
  ): Promise<RoomState> {
    const kvStore = getKvStore();
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "This room does not exist or has expired.");
    }
    updater(room);
    if (options.touchUpdatedAt ?? true) {
      room.updatedAt = Date.now();
    }
    if (options.touchPlaybackUpdatedAt) {
      room.playbackUpdatedAt = Date.now();
      room.playbackSequence += 1;
      room.playbackCommand = options.playbackCommand ?? room.playbackCommand;
    }
    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: ROOM_TTL_SECONDS });
    return room;
  }

  async joinRoom(roomId: string, participant: Participant): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      const normalizedName = participant.name.trim();
      if (!normalizedName) {
        throw new RoomError("INVALID_ROOM_MEMBER", "A display name is required to join the room.");
      }

      const existing = room.participants.find(
        (entry) => entry.clientId === participant.clientId || entry.userId === participant.userId
      );
      if (!existing && room.participants.length >= 2) {
        throw new RoomError("ROOM_FULL", "This room already has two participants.");
      }

      if (existing) {
        room.participants = room.participants.map((entry) =>
          entry.clientId === existing.clientId
            ? {
                ...entry,
                clientId: participant.clientId,
                userId: participant.userId,
                socketId: participant.socketId,
                name: normalizedName,
                image: participant.image ?? null,
                lastSeenAt: participant.lastSeenAt
              }
            : entry
        );
      } else {
        room.participants.push({
          ...participant,
          name: normalizedName
        });
      }
      room.emptySinceAt = null;
      room.typingParticipants = room.typingParticipants.filter(
        (entry) => entry.clientId !== participant.clientId
      );
      if (!room.ownerClientId) {
        room.ownerClientId = participant.clientId;
      }
    });
  }

  async touchParticipant(roomId: string, clientId: string, userId: string): Promise<RoomState> {
    return this.updateRoom(
      roomId,
      (room) => {
        const participant = room.participants.find(
          (entry) => entry.clientId === clientId || entry.userId === userId
        );

        if (!participant) {
          throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
        }

        room.participants = room.participants.map((entry) =>
          entry.clientId === participant.clientId
            ? {
                ...entry,
                clientId,
                userId,
                socketId: clientId,
                lastSeenAt: Date.now()
              }
            : entry
        );
      },
      { touchUpdatedAt: false }
    );
  }

  async leaveRoom(roomId: string, clientId: string): Promise<RoomState | null> {
    const kvStore = getKvStore();
    const room = await this.getRoom(roomId);
    if (!room) {
      return null;
    }

    room.participants = room.participants.filter((entry) => entry.clientId !== clientId);
    room.typingParticipants = room.typingParticipants.filter((entry) => entry.clientId !== clientId);
    if (room.ownerClientId === clientId) {
      room.ownerClientId = room.participants[0]?.clientId ?? null;
    }
    room.emptySinceAt = room.participants.length === 0 ? Date.now() : null;
    room.updatedAt = Date.now();

    await kvStore.set(`${ROOM_PREFIX}${roomId}`, room, { ex: ROOM_TTL_SECONDS });
    return room;
  }

  async updateVideo(
    roomId: string,
    clientId: string,
    userId: string,
    videoId: string
  ): Promise<RoomState> {
    return this.updateRoom(
      roomId,
      (room) => {
        this.requireMember(room, clientId);
        const participant = this.getParticipant(room, clientId, userId);
        room.videoId = videoId;
        room.playbackState = "playing";
        room.currentTimeSeconds = 0;
        room.playbackControllerClientId = participant.clientId;
        room.playbackControllerUserId = participant.userId;
        room.playbackControllerName = participant.name;
      },
      { touchPlaybackUpdatedAt: true, playbackCommand: "video:set" }
    );
  }

  async play(
    roomId: string,
    clientId: string,
    userId: string,
    currentTimeSeconds: number
  ): Promise<RoomState> {
    return this.updateRoom(
      roomId,
      (room) => {
        this.requirePlaybackAuthority(room, clientId, userId);
        room.playbackState = "playing";
        room.currentTimeSeconds = clampTime(currentTimeSeconds);
      },
      { touchPlaybackUpdatedAt: true, playbackCommand: "playback:play" }
    );
  }

  async pause(
    roomId: string,
    clientId: string,
    userId: string,
    currentTimeSeconds: number
  ): Promise<RoomState> {
    return this.updateRoom(
      roomId,
      (room) => {
        this.requirePlaybackAuthority(room, clientId, userId);
        room.playbackState = "paused";
        room.currentTimeSeconds = clampTime(currentTimeSeconds);
      },
      { touchPlaybackUpdatedAt: true, playbackCommand: "playback:pause" }
    );
  }

  async seek(
    roomId: string,
    clientId: string,
    userId: string,
    currentTimeSeconds: number
  ): Promise<RoomState> {
    return this.updateRoom(
      roomId,
      (room) => {
        this.requirePlaybackAuthority(room, clientId, userId);
        room.currentTimeSeconds = clampTime(currentTimeSeconds);
      },
      { touchPlaybackUpdatedAt: true, playbackCommand: "playback:seek" }
    );
  }

  async setPlaybackControlMode(
    roomId: string,
    clientId: string,
    userId: string,
    mode: PlaybackControlMode
  ): Promise<RoomState> {
    return this.updateRoom(roomId, (room) => {
      this.requireMember(room, clientId);
      if (room.ownerUserId !== userId) {
        throw new RoomError("INVALID_ROOM_MEMBER", "Only the space host can change playback control mode.");
      }
      room.playbackControlMode = mode;
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

  private getParticipant(room: RoomState, clientId: string, userId: string): Participant {
    const participant = room.participants.find(
      (entry) => entry.clientId === clientId || entry.userId === userId
    );

    if (!participant) {
      throw new RoomError("INVALID_ROOM_MEMBER", "You are not connected to this room.");
    }

    return participant;
  }

  private requirePlaybackAuthority(room: RoomState, clientId: string, userId: string): void {
    this.requireMember(room, clientId);

    if (room.playbackControlMode === "owner" && room.ownerUserId !== userId) {
      throw new RoomError(
        "INVALID_ROOM_MEMBER",
        "Playback is currently controlled by the space host."
      );
    }

    if (
      room.playbackControllerUserId &&
      room.playbackControllerUserId !== userId &&
      room.playbackControllerClientId !== clientId
    ) {
      throw new RoomError(
        "INVALID_ROOM_MEMBER",
        `${room.playbackControllerName ?? "The current controller"} is controlling this video. Sync a new video to take control.`
      );
    }
  }
}

function cleanupRoomPresence(
  room: RoomState
): { room: RoomState; changed: boolean; shouldDelete: boolean } {
  const now = Date.now();
  const activeParticipants = room.participants.filter((participant) => {
    if (!Number.isFinite(participant.lastSeenAt)) {
      return false;
    }
    return now - participant.lastSeenAt <= PARTICIPANT_STALE_MS;
  });
  const removedClientIds = new Set(
    room.participants
      .filter((participant) => {
        if (!Number.isFinite(participant.lastSeenAt)) {
          return true;
        }
        return now - participant.lastSeenAt > PARTICIPANT_STALE_MS;
      })
      .map((participant) => participant.clientId)
  );

  const nextOwnerClientId = activeParticipants.some(
    (participant) => participant.clientId === room.ownerClientId
  )
    ? room.ownerClientId
    : activeParticipants[0]?.clientId ?? null;

  const nextTypingParticipants = room.typingParticipants.filter(
    (participant) => !removedClientIds.has(participant.clientId)
  );
  const nextEmptySinceAt =
    activeParticipants.length === 0 ? room.emptySinceAt ?? now : null;
  const shouldDelete =
    activeParticipants.length === 0 &&
    Number.isFinite(nextEmptySinceAt) &&
    now - (nextEmptySinceAt as number) >= EMPTY_ROOM_GRACE_MS;

  const changed =
    activeParticipants.length !== room.participants.length ||
    nextOwnerClientId !== room.ownerClientId ||
    nextTypingParticipants.length !== room.typingParticipants.length ||
    (room.emptySinceAt ?? null) !== nextEmptySinceAt;

  if (!changed) {
    return { room, changed: false, shouldDelete };
  }

  return {
    changed: true,
    shouldDelete,
    room: {
      ...room,
      ownerClientId: nextOwnerClientId,
      emptySinceAt: nextEmptySinceAt,
      participants: activeParticipants,
      typingParticipants: nextTypingParticipants
    }
  };
}

function normalizeRoomState(room: RoomState): RoomState {
  return {
    ...room,
    playbackUpdatedAt:
      Number.isFinite(room.playbackUpdatedAt) ? room.playbackUpdatedAt : room.updatedAt ?? room.createdAt,
    playbackSequence: Number.isFinite(room.playbackSequence) ? room.playbackSequence : 0,
    playbackCommand: room.playbackCommand ?? null,
    playbackControlMode: room.playbackControlMode ?? "shared",
    playbackControllerClientId: room.playbackControllerClientId ?? null,
    playbackControllerUserId: room.playbackControllerUserId ?? null,
    playbackControllerName: room.playbackControllerName ?? null
  };
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

export function getRoomStore(): RoomStore {
  if (!global.__syncScreenRoomsAsync) {
    global.__syncScreenRoomsAsync = new RoomStore();
  }
  return global.__syncScreenRoomsAsync;
}
