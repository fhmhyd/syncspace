"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Pusher from "pusher-js";
import { saveStoredProfileName } from "@/lib/profile";
import ThemeToggle from "@/components/theme-toggle";
import { extractYouTubeVideoId } from "@/lib/youtube";
import type { RoomErrorPayload, RoomStatePayload } from "@/lib/socket-types";

type Viewer = {
  id: string;
  email?: string | null;
  image?: string | null;
  googleName: string;
  displayName: string;
};

type YouTubePlayer = {
  destroy(): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
};

type YouTubeStateChangeEvent = {
  target: YouTubePlayer;
  data: number;
};

type YouTubeErrorEvent = {
  data: number;
};

type YouTubeApi = {
  Player: new (
    elementId: string,
    options: {
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: YouTubeStateChangeEvent) => void;
        onError?: (event: YouTubeErrorEvent) => void;
      };
    }
  ) => YouTubePlayer;
  PlayerState: {
    PLAYING: number;
    PAUSED: number;
  };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const PLAYBACK_APPLY_TOLERANCE = 0.25;
const PLAYER_SUPPRESS_MS = 1200;
const PLAYER_TIMELINE_POLL_MS = 250;
const VIEWER_SYNC_INTERVAL_MS = 300;
const CHAT_TYPING_IDLE_MS = 1200;
const CHAT_TYPING_STALE_MS = 4000;
const PRESENCE_HEARTBEAT_MS = 10_000;
const HARD_RESYNC_DRIFT_SECONDS = 1.15;
const SOFT_RESYNC_DRIFT_SECONDS = 0.55;
const DIRECT_PLAYBACK_DEDUPE_MS = 2000;
const HOST_SEEK_DETECTION_DELTA_SECONDS = 0.45;
const HOST_SEEK_EMIT_COOLDOWN_MS = 250;
const HOST_STATE_EMIT_COOLDOWN_MS = 350;

type Props = {
  roomId: string;
  viewer: Viewer;
};

type RoomChannelPayload = {
  state: RoomStatePayload;
  syncedBy?: string;
  participantEvent?: RoomStatePayload["participantEvent"];
  syncEvent?: RoomStatePayload["syncEvent"];
};

type RealtimePlaybackChannel = {
  bind(eventName: string, callback: (payload: unknown) => void): void;
  trigger(eventName: string, payload: unknown): boolean;
};

type DirectPlaybackCommandPayload = {
  action: "video:set" | "playback:play" | "playback:pause" | "playback:seek";
  actorClientId: string;
  videoId?: string | null;
  currentTimeSeconds: number;
  playbackState: RoomStatePayload["playbackState"];
  issuedAt: number;
};

type DirectChatMessagePayload = {
  clientMessageId: string;
  clientId: string;
  authorName: string;
  authorImage?: string | null;
  body: string;
  sentAt: number;
};

export default function WatchRoomClient({ roomId, viewer }: Props) {
  const [shareUrl, setShareUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [displayName, setDisplayName] = useState(viewer.displayName);
  const [draftName, setDraftName] = useState(viewer.displayName);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [inputUrl, setInputUrl] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("Connecting...");
  const [roomState, setRoomState] = useState<RoomStatePayload | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [typingTick, setTypingTick] = useState(0);

  const pusherRef = useRef<Pusher | null>(null);
  const realtimeChannelRef = useRef<RealtimePlaybackChannel | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const suppressPlayerEventsRef = useRef(false);
  const knownVideoIdRef = useRef<string | null>(null);
  const joinedRef = useRef(false);
  const roomStateRef = useRef<RoomStatePayload | null>(null);
  const playerReadyRef = useRef(false);
  const driftWarningCountRef = useRef(0);
  const lastAppliedPlaybackRef = useRef<{
    videoId: string | null;
    playbackState: RoomStatePayload["playbackState"];
    currentTimeSeconds: number;
    playbackUpdatedAt: number;
    playbackSequence: number;
  } | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const typingStopTimeoutRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const hostPlaybackStateRef = useRef<RoomStatePayload["playbackState"]>("paused");
  const hostSeekSampleRef = useRef<{ time: number; sampledAt: number } | null>(null);
  const lastHostSeekEmitAtRef = useRef(0);
  const lastHostStateEmitRef = useRef<{
    action: "playback:play" | "playback:pause";
    issuedAt: number;
    currentTimeSeconds: number;
  } | null>(null);
  const queuedRemotePlaybackRef = useRef<DirectPlaybackCommandPayload | null>(null);
  const optimisticChatMessagesRef = useRef<Map<string, RoomStatePayload["chatMessages"][number]>>(
    new Map()
  );
  const recentRemoteChatIdsRef = useRef<Set<string>>(new Set());
  const pendingLocalSyncRef = useRef<{
    syncEvent:
      | "video:set"
      | "playback:play"
      | "playback:pause"
      | "playback:seek"
      | "chat:message"
      | "chat:read";
    issuedAt: number;
  } | null>(null);
  const lastDirectPlaybackEventRef = useRef<string | null>(null);
  const recentRemotePlaybackRef = useRef<{
    action: DirectPlaybackCommandPayload["action"];
    currentTimeSeconds: number;
    videoId?: string | null;
    playbackState: RoomStatePayload["playbackState"];
    issuedAt: number;
  } | null>(null);
  const canControlPlayback =
    !roomState?.videoId ||
    !roomState.playbackControllerUserId ||
    roomState.playbackControllerUserId === viewer.id ||
    roomState.playbackControllerClientId === clientId;

  const emitAction = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, clientId, ...payload })
      });

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        const message =
          errorPayload?.message ?? errorPayload?.error ?? "The space action failed.";
        setInlineNotice(null);
        setInlineError(message);
        return null;
      }

      return response;
    } catch (e) {
      console.error(e);
      setInlineNotice(null);
      setInlineError("The space action failed. Please try again.");
      return null;
    }
  }, [roomId, clientId]);

  function runWithSuppressedPlayerEvents(action: () => void) {
    action();
    suppressPlayerEventsRef.current = true;
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, PLAYER_SUPPRESS_MS);
  }

  function markPendingLocalSync(
    syncEvent:
      | "video:set"
      | "playback:play"
      | "playback:pause"
      | "playback:seek"
      | "chat:message"
      | "chat:read"
  ) {
    pendingLocalSyncRef.current = {
      syncEvent,
      issuedAt: Date.now()
    };
  }

  function triggerDirectPlaybackCommand(payload: DirectPlaybackCommandPayload) {
    const channel = realtimeChannelRef.current;
    if (!channel || typeof channel.trigger !== "function") {
      return;
    }

    try {
      channel.trigger("client-playback-command", payload);
    } catch (error) {
      console.error(error);
    }
  }

  function triggerDirectChatMessage(payload: DirectChatMessagePayload) {
    const channel = realtimeChannelRef.current;
    if (!channel || typeof channel.trigger !== "function") {
      return;
    }

    try {
      channel.trigger("client-chat-message", payload);
    } catch (error) {
      console.error(error);
    }
  }

  function mergeOptimisticChatMessages(
    messages: RoomStatePayload["chatMessages"]
  ): RoomStatePayload["chatMessages"] {
    const merged = [...messages];
    const knownClientMessageIds = new Set(
      messages
        .map((message) => message.clientMessageId)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );

    optimisticChatMessagesRef.current.forEach((message, clientMessageId) => {
      if (!knownClientMessageIds.has(clientMessageId)) {
        merged.push(message);
      }
    });

    return merged
      .sort((left, right) => left.sentAt - right.sentAt)
      .slice(-100);
  }

  function acknowledgeOptimisticChatMessages(messages: RoomStatePayload["chatMessages"]) {
    const deliveredIds = new Set(
      messages
        .map((message) => message.clientMessageId)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );

    deliveredIds.forEach((clientMessageId) => {
      optimisticChatMessagesRef.current.delete(clientMessageId);
      recentRemoteChatIdsRef.current.delete(clientMessageId);
    });
  }

  const applyDirectPlaybackCommand = useCallback((payload: DirectPlaybackCommandPayload) => {
    const player = playerRef.current;
    if (
      !player ||
      !playerReadyRef.current ||
      typeof player.seekTo !== "function" ||
      typeof player.playVideo !== "function" ||
      typeof player.pauseVideo !== "function" ||
      typeof player.loadVideoById !== "function"
    ) {
      return false;
    }

    const activeVideoId = payload.videoId ?? knownVideoIdRef.current ?? roomStateRef.current?.videoId ?? null;
    if (!activeVideoId) {
      return false;
    }

    runWithSuppressedPlayerEvents(() => {
      if (knownVideoIdRef.current !== activeVideoId || payload.action === "video:set") {
        knownVideoIdRef.current = activeVideoId;
        player.loadVideoById(activeVideoId, payload.currentTimeSeconds);
      } else {
        player.seekTo(payload.currentTimeSeconds, true);
      }

      if (payload.playbackState === "playing") {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
    });
    return true;
  }, []);

  const dispatchPlaybackCommand = useCallback(async (
    action: DirectPlaybackCommandPayload["action"],
    options: {
      currentTimeSeconds: number;
      videoId?: string | null;
      playbackState: RoomStatePayload["playbackState"];
      applyLocally?: boolean;
    }
  ) => {
    if (!joinedRef.current || !canControlPlayback) {
      return;
    }

    const payload: DirectPlaybackCommandPayload = {
      action,
      actorClientId: clientId,
      currentTimeSeconds: clampPlaybackTime(options.currentTimeSeconds),
      videoId: options.videoId ?? knownVideoIdRef.current ?? roomStateRef.current?.videoId ?? null,
      playbackState: options.playbackState,
      issuedAt: Date.now()
    };

    markPendingLocalSync(action);
    if (options.applyLocally ?? true) {
      applyDirectPlaybackCommand(payload);
    }
    triggerDirectPlaybackCommand(payload);

    if (action === "video:set" && options.videoId) {
      await emitAction("video:set", { videoId: options.videoId });
      return;
    }

    await emitAction(action, { currentTimeSeconds: payload.currentTimeSeconds });
  }, [applyDirectPlaybackCommand, canControlPlayback, clientId, emitAction]);

  const emitLeaveRequest = useCallback((currentClientId: string) => {
    void fetch(`/api/rooms/${roomId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "room:leave", clientId: currentClientId }),
      keepalive: true
    }).catch(() => undefined);
  }, [roomId]);

  const applyRoomStateToPlayer = useCallback((nextState: RoomStatePayload) => {
    const player = playerRef.current;
    if (
      !player ||
      !playerReadyRef.current ||
      typeof player.loadVideoById !== "function" ||
      typeof player.playVideo !== "function" ||
      typeof player.pauseVideo !== "function" ||
      typeof player.seekTo !== "function" ||
      typeof player.getCurrentTime !== "function"
    ) {
      return;
    }

    if (nextState.videoId && knownVideoIdRef.current !== nextState.videoId) {
      const videoId = nextState.videoId;
      knownVideoIdRef.current = videoId;
      driftWarningCountRef.current = 0;
      runWithSuppressedPlayerEvents(() => {
        player.loadVideoById(videoId, getExpectedRoomTime(nextState));
        window.setTimeout(() => {
          if (nextState.playbackState === "playing") {
            player.playVideo();
          } else {
            player.pauseVideo();
          }
        }, 250);
      });
      return;
    }

    const expectedTimeSeconds = getExpectedRoomTime(nextState);
    const localTime = player.getCurrentTime();
    const driftSeconds = Math.abs(localTime - expectedTimeSeconds);

    if (
      nextState.playbackState === "paused" ||
      nextState.playbackCommand === "playback:seek" ||
      nextState.playbackCommand === "video:set" ||
      driftSeconds > PLAYBACK_APPLY_TOLERANCE
    ) {
      runWithSuppressedPlayerEvents(() => {
        player.seekTo(expectedTimeSeconds, true);
      });
    }

    runWithSuppressedPlayerEvents(() => {
      if (nextState.playbackState === "playing") {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
    });

    lastAppliedPlaybackRef.current = {
      videoId: nextState.videoId,
      playbackState: nextState.playbackState,
      currentTimeSeconds: nextState.currentTimeSeconds,
      playbackUpdatedAt: nextState.playbackUpdatedAt,
      playbackSequence: nextState.playbackSequence
    };
  }, []);

  useEffect(() => {
    setShareUrl(window.location.href);
    setClientId(createClientId());
    setDisplayName(viewer.displayName);
    setDraftName(viewer.displayName);
  }, [viewer.displayName]);

  useEffect(() => {
    if (!clientId) return;

    let isMounted = true;
    let pusher: Pusher;

    const boot = () => {
      setConnectionLabel("Starting space connection...");

      pusher = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY || "", {
        cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER || "us2",
        channelAuthorization: {
          transport: "ajax",
          endpoint: "/api/pusher/auth"
        }
      });

      pusherRef.current = pusher;
      const channel = pusher.subscribe(`room-${roomId}`);
      const realtimeChannel = pusher.subscribe(`private-room-${roomId}`);
      realtimeChannelRef.current = realtimeChannel;

      realtimeChannel.bind("client-playback-command", (payload: DirectPlaybackCommandPayload) => {
        if (!isMounted || payload.actorClientId === clientId) {
          return;
        }

        const eventKey = [
          payload.actorClientId,
          payload.action,
          payload.issuedAt,
          payload.videoId ?? "",
          payload.currentTimeSeconds.toFixed(2)
        ].join(":");

        if (lastDirectPlaybackEventRef.current === eventKey) {
          return;
        }
        lastDirectPlaybackEventRef.current = eventKey;

        const applied = applyDirectPlaybackCommand(payload);
        if (applied) {
          recentRemotePlaybackRef.current = {
            action: payload.action,
            currentTimeSeconds: payload.currentTimeSeconds,
            videoId: payload.videoId,
            playbackState: payload.playbackState,
            issuedAt: payload.issuedAt
          };
        } else {
          queuedRemotePlaybackRef.current = payload;
        }
      });

      realtimeChannel.bind("client-chat-message", (payload: DirectChatMessagePayload) => {
        if (!isMounted || payload.clientId === clientId) {
          return;
        }

        if (recentRemoteChatIdsRef.current.has(payload.clientMessageId)) {
          return;
        }
        recentRemoteChatIdsRef.current.add(payload.clientMessageId);

        const nextMessage = {
          id: `remote-${payload.clientMessageId}`,
          clientMessageId: payload.clientMessageId,
          clientId: payload.clientId,
          authorName: payload.authorName,
          authorImage: payload.authorImage ?? null,
          body: payload.body,
          sentAt: payload.sentAt,
          readByClientIds: [payload.clientId]
        };

        optimisticChatMessagesRef.current.set(payload.clientMessageId, nextMessage);
        setRoomState((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            chatMessages: mergeOptimisticChatMessages(current.chatMessages)
          };
        });
      });

      channel.bind("room:state", (data: RoomChannelPayload) => {
        if (!isMounted) return;
        joinedRef.current = true;
        const nextState = data.state;
        const previousState = roomStateRef.current;
        if (
          pendingLocalSyncRef.current &&
          data.syncedBy === clientId &&
          data.syncEvent === pendingLocalSyncRef.current.syncEvent
        ) {
          pendingLocalSyncRef.current = null;
        }
        acknowledgeOptimisticChatMessages(nextState.chatMessages ?? []);
        const mergedState = {
          ...nextState,
          chatMessages: mergeOptimisticChatMessages(nextState.chatMessages ?? [])
        };
        roomStateRef.current = mergedState;
        setRoomState(mergedState);
        setJoinError(null);
        setInlineError(null);
        setInlineNotice(getRoomNotice(data, clientId));
        setConnectionLabel(getPresenceMessage(mergedState.participants?.length || 0));
        if (
          shouldApplyIncomingPlayback(previousState, mergedState, data.syncEvent) &&
          !shouldSkipPlaybackApply({
            syncedBy: data.syncedBy,
            syncEvent: data.syncEvent,
            clientId,
            nextState: mergedState,
            recentRemotePlayback: recentRemotePlaybackRef.current
          })
        ) {
          applyRoomStateToPlayer(mergedState);
        }
      });

      channel.bind("room:error", (payload: RoomErrorPayload) => {
        if (!isMounted) return;
        joinedRef.current = false;
        setConnectionLabel("Unable to join space.");
        setJoinError(payload.message);
      });

      pusher.connection.bind("connected", () => {
        if (!isMounted) return;
        setConnectionLabel("Connected. Joining space...");
        emitAction("room:join", {
           displayName,
           image: viewer.image ?? null
        });
      });

      pusher.connection.bind("disconnected", () => {
        if (!isMounted) return;
        setConnectionLabel("Disconnected. Reconnecting...");
      });

      pusher.connection.bind("error", () => {
        if (!isMounted) return;
        setConnectionLabel("Space connection failed. Retrying...");
        setJoinError("Could not connect to the space server yet. Retrying...");
      });
    };

    boot();

    const heartbeatId = window.setInterval(() => {
      if (joinedRef.current) {
        emitAction("room:heartbeat");
      }
    }, PRESENCE_HEARTBEAT_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && joinedRef.current) {
        emitAction("room:heartbeat");
      }
    };

    const handleBeforeUnload = () => {
      emitLeaveRequest(clientId);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMounted = false;
      if (clientId) {
        emitLeaveRequest(clientId);
      }
      window.clearInterval(heartbeatId);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      pusher?.disconnect();
      realtimeChannelRef.current = null;
    };
  }, [applyDirectPlaybackCommand, applyRoomStateToPlayer, clientId, displayName, roomId, viewer.image, emitAction, emitLeaveRequest]);

  useEffect(() => {
    let cancelled = false;

    void loadYouTubeApi().then(() => {
      if (cancelled || playerRef.current || !window.YT) {
        return;
      }

      playerRef.current = new window.YT.Player("youtube-player", {
        playerVars: {
          playsinline: 1,
          rel: 0,
          controls: 1,
          disablekb: 0,
          modestbranding: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            playerReadyRef.current = true;
            if (queuedRemotePlaybackRef.current) {
              const queuedPlayback = queuedRemotePlaybackRef.current;
              queuedRemotePlaybackRef.current = null;
              if (applyDirectPlaybackCommand(queuedPlayback)) {
                recentRemotePlaybackRef.current = {
                  action: queuedPlayback.action,
                  currentTimeSeconds: queuedPlayback.currentTimeSeconds,
                  videoId: queuedPlayback.videoId,
                  playbackState: queuedPlayback.playbackState,
                  issuedAt: queuedPlayback.issuedAt
                };
              }
            }
            if (roomStateRef.current) {
              applyRoomStateToPlayer(roomStateRef.current);
            }
          },
          onStateChange: (event) => {
            if (
              suppressPlayerEventsRef.current ||
              !joinedRef.current ||
              !canControlPlayback ||
              !roomStateRef.current?.videoId ||
              typeof event.target.getCurrentTime !== "function" ||
              !window.YT
            ) {
              return;
            }

            const currentTimeSeconds = clampPlaybackTime(event.target.getCurrentTime());

            if (event.data === window.YT.PlayerState.PLAYING) {
              hostPlaybackStateRef.current = "playing";
              if (
                shouldEmitHostPlaybackState(
                  lastHostStateEmitRef.current,
                  "playback:play",
                  currentTimeSeconds
                )
              ) {
                lastHostStateEmitRef.current = {
                  action: "playback:play",
                  issuedAt: Date.now(),
                  currentTimeSeconds
                };
                void dispatchPlaybackCommand("playback:play", {
                  currentTimeSeconds,
                  playbackState: "playing",
                  applyLocally: false
                });
              }
              return;
            }

            if (event.data === window.YT.PlayerState.PAUSED) {
              hostPlaybackStateRef.current = "paused";
              if (
                shouldEmitHostPlaybackState(
                  lastHostStateEmitRef.current,
                  "playback:pause",
                  currentTimeSeconds
                )
              ) {
                lastHostStateEmitRef.current = {
                  action: "playback:pause",
                  issuedAt: Date.now(),
                  currentTimeSeconds
                };
                void dispatchPlaybackCommand("playback:pause", {
                  currentTimeSeconds,
                  playbackState: "paused",
                  applyLocally: false
                });
              }
            }
          },
          onError: (event) => {
            console.error("YouTube player error", event.data);
            queuedRemotePlaybackRef.current = null;
            knownVideoIdRef.current = roomStateRef.current?.videoId ?? knownVideoIdRef.current;

            window.setTimeout(() => {
              if (roomStateRef.current) {
                applyRoomStateToPlayer(roomStateRef.current);
              }
            }, 250);
          }
        }
      });
    });

    return () => {
      cancelled = true;
      playerReadyRef.current = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [applyDirectPlaybackCommand, applyRoomStateToPlayer, canControlPlayback, dispatchPlaybackCommand]);

  useEffect(() => {
    if (!playerRef.current || !playerReadyRef.current || !roomState?.videoId || !canControlPlayback) {
      hostSeekSampleRef.current = null;
      return;
    }

    const intervalId = window.setInterval(() => {
      if (
        !playerRef.current ||
        suppressPlayerEventsRef.current ||
        typeof playerRef.current.getCurrentTime !== "function"
      ) {
        return;
      }

      const currentTimeSeconds = clampPlaybackTime(playerRef.current.getCurrentTime());
      const sampledAt = Date.now();
      const previousSample = hostSeekSampleRef.current;
      hostSeekSampleRef.current = { time: currentTimeSeconds, sampledAt };

      if (!previousSample) {
        return;
      }

      const elapsedSeconds = (sampledAt - previousSample.sampledAt) / 1000;
      const expectedAdvance = hostPlaybackStateRef.current === "playing" ? elapsedSeconds : 0;
      const measuredAdvance = currentTimeSeconds - previousSample.time;
      const seekDelta = measuredAdvance - expectedAdvance;

      if (
        Math.abs(seekDelta) < HOST_SEEK_DETECTION_DELTA_SECONDS ||
        sampledAt - lastHostSeekEmitAtRef.current < HOST_SEEK_EMIT_COOLDOWN_MS
      ) {
        return;
      }

      lastHostSeekEmitAtRef.current = sampledAt;
      void dispatchPlaybackCommand("playback:seek", {
        currentTimeSeconds,
        playbackState: hostPlaybackStateRef.current,
        applyLocally: false
      });
    }, PLAYER_TIMELINE_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [canControlPlayback, dispatchPlaybackCommand, roomState?.videoId]);

  useEffect(() => {
    if (!playerRef.current || !joinedRef.current || !playerReadyRef.current || !roomState || canControlPlayback) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (
        !playerRef.current ||
        suppressPlayerEventsRef.current ||
        typeof playerRef.current.getCurrentTime !== "function"
      ) {
        return;
      }

      const currentTimeSeconds = playerRef.current.getCurrentTime();
      const expectedTimeSeconds = getExpectedRoomTime(roomState);
      const driftSeconds = Math.abs(currentTimeSeconds - expectedTimeSeconds);

      if (roomState.playbackState === "playing") {
        if (driftSeconds > HARD_RESYNC_DRIFT_SECONDS) {
          driftWarningCountRef.current = 0;
          runWithSuppressedPlayerEvents(() => {
            playerRef.current?.seekTo(expectedTimeSeconds, true);
            playerRef.current?.playVideo();
          });
        } else if (driftSeconds > SOFT_RESYNC_DRIFT_SECONDS) {
          driftWarningCountRef.current += 1;
          if (driftWarningCountRef.current >= 2) {
            driftWarningCountRef.current = 0;
            runWithSuppressedPlayerEvents(() => {
              playerRef.current?.seekTo(expectedTimeSeconds, true);
              playerRef.current?.playVideo();
            });
          }
        } else {
          driftWarningCountRef.current = 0;
        }
      } else {
        driftWarningCountRef.current = 0;
        if (driftSeconds > PLAYBACK_APPLY_TOLERANCE) {
          runWithSuppressedPlayerEvents(() => {
            playerRef.current?.seekTo(expectedTimeSeconds, true);
            playerRef.current?.pauseVideo();
          });
        }
      }
    }, VIEWER_SYNC_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [canControlPlayback, roomState]);

  useEffect(() => {
    if (!roomState || !playerRef.current || !playerReadyRef.current) {
      return;
    }

    const previousApplied = lastAppliedPlaybackRef.current;
    roomStateRef.current = roomState;
    const isActiveController =
      !!roomState.videoId &&
      (roomState.playbackControllerUserId === viewer.id ||
        roomState.playbackControllerClientId === clientId);

    if (
      (!previousApplied ||
        previousApplied.videoId !== roomState.videoId ||
        previousApplied.playbackState !== roomState.playbackState ||
        Math.abs(previousApplied.currentTimeSeconds - roomState.currentTimeSeconds) > PLAYBACK_APPLY_TOLERANCE ||
        previousApplied.playbackUpdatedAt !== roomState.playbackUpdatedAt ||
        previousApplied.playbackSequence !== roomState.playbackSequence) &&
      (!isActiveController || roomState.playbackCommand === "video:set") &&
      !shouldSkipPlaybackApply({
        syncedBy: undefined,
        syncEvent: roomState.playbackCommand ?? undefined,
        clientId,
        nextState: roomState,
        recentRemotePlayback: recentRemotePlaybackRef.current
      })
    ) {
      applyRoomStateToPlayer(roomState);
    }
  }, [applyRoomStateToPlayer, clientId, roomState, viewer.id]);

  useEffect(() => {
    if (!isChatOpen || !chatListRef.current) {
      return;
    }

    chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
  }, [isChatOpen, roomState?.chatMessages]);

  useEffect(() => {
    if (!isChatOpen || !roomState?.chatMessages.length || !joinedRef.current) {
      return;
    }

    const latestUnread = [...roomState.chatMessages]
      .reverse()
      .find(
        (message) =>
          message.clientId !== clientId && !message.readByClientIds.includes(clientId)
      );

    if (!latestUnread) {
      return;
    }

    setRoomState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        chatMessages: current.chatMessages.map((message) =>
          message.id === latestUnread.id && !message.readByClientIds.includes(clientId)
            ? {
                ...message,
                readByClientIds: [...message.readByClientIds, clientId]
              }
            : message
        )
      };
    });
    markPendingLocalSync("chat:read");
    emitAction("chat:read", { messageId: latestUnread.id });
  }, [clientId, isChatOpen, roomState?.chatMessages, emitAction]);

  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current !== null) {
        window.clearTimeout(typingStopTimeoutRef.current);
      }
      if (typingActiveRef.current && clientId) {
        void fetch(`/api/rooms/${roomId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "chat:typing", clientId, isTyping: false }),
          keepalive: true
        }).catch(() => undefined);
      }
    };
  }, [clientId, roomId]);

  useEffect(() => {
    if (isChatOpen) {
      return;
    }

    if (typingStopTimeoutRef.current !== null) {
      window.clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }

    if (!typingActiveRef.current || !joinedRef.current) {
      return;
    }

    typingActiveRef.current = false;
    emitAction("chat:typing", { isTyping: false });
  }, [emitAction, isChatOpen]);

  useEffect(() => {
    if ((roomState?.typingParticipants?.length ?? 0) === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setTypingTick(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [roomState?.typingParticipants?.length]);

  function submitVideo() {
    if (!joinedRef.current) {
      setInlineNotice(null);
      setInlineError("Space is still connecting. Wait for the status to show connected.");
      return;
    }

    const videoId = extractYouTubeVideoId(inputUrl);
    if (!videoId) {
      setInlineNotice(null);
      setInlineError("Enter a valid YouTube URL.");
      return;
    }

    setInlineError(null);
    setInlineNotice("Sending video to the space...");
    void dispatchPlaybackCommand("video:set", {
      videoId,
      currentTimeSeconds: 0,
      playbackState: "playing"
    });
    setInputUrl("");
  }

  async function copyShareUrl() {
    await navigator.clipboard.writeText(shareUrl);
  }

  function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const storedName = saveStoredProfileName(viewer.id, draftName);
    if (!storedName) {
      return;
    }

    setDisplayName(storedName);
    setDraftName(storedName);
    setInlineNotice("Updated your display name. Refreshing space presence...");
    setIsProfileOpen(false);

    joinedRef.current = false;
    setJoinError(null);
    setConnectionLabel("Refreshing your space profile...");
    emitAction("room:join", {
      displayName: storedName,
      image: viewer.image ?? null
    });
  }

  async function submitChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = chatDraft.trim();
    if (!value || !joinedRef.current || isSendingChat) {
      return;
    }

    const clientMessageId = crypto.randomUUID();
    const optimisticMessage = {
      id: `pending-${clientMessageId}`,
      clientMessageId,
      clientId,
      authorName: displayName,
      authorImage: viewer.image ?? null,
      body: value,
      sentAt: Date.now(),
      readByClientIds: [clientId]
    };

    setTypingState(false);
    optimisticChatMessagesRef.current.set(clientMessageId, optimisticMessage);
    setRoomState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        chatMessages: mergeOptimisticChatMessages(current.chatMessages)
      };
    });

    triggerDirectChatMessage({
      clientMessageId,
      clientId,
      authorName: displayName,
      authorImage: viewer.image ?? null,
      body: value,
      sentAt: optimisticMessage.sentAt
    });

    markPendingLocalSync("chat:message");
    setChatDraft("");
    setIsChatOpen(true);
    setInlineError(null);
    setIsSendingChat(true);

    const response = await emitAction("chat:message", {
      body: value,
      clientMessageId
    });

    if (response) {
      setIsSendingChat(false);
      return;
    }

    optimisticChatMessagesRef.current.delete(clientMessageId);
    recentRemoteChatIdsRef.current.delete(clientMessageId);
    setRoomState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        chatMessages: mergeOptimisticChatMessages(
          current.chatMessages.filter((message) => message.clientMessageId !== clientMessageId)
        )
      };
    });
    setIsSendingChat(false);
    setChatDraft((current) => (current ? current : value));
  }

  function setTypingState(isTyping: boolean) {
    if (!joinedRef.current) {
      return;
    }

    if (typingStopTimeoutRef.current !== null) {
      window.clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }

    if (!isTyping && !typingActiveRef.current) {
      return;
    }

    typingActiveRef.current = isTyping;
    emitAction("chat:typing", { isTyping });

    if (isTyping) {
      typingStopTimeoutRef.current = window.setTimeout(() => {
        typingActiveRef.current = false;
        emitAction("chat:typing", { isTyping: false });
        typingStopTimeoutRef.current = null;
      }, CHAT_TYPING_IDLE_MS);
    }
  }

  const participants = roomState?.participants ?? [];
  const indicatorClass = participants.length >= 2 ? "success" : joinError ? "danger" : "";
  const visibleChatMessages = roomState?.chatMessages ?? [];
  const unreadCount = visibleChatMessages.filter(
    (message) => message.clientId !== clientId && !message.readByClientIds.includes(clientId)
  ).length;
  const typingReferenceTime = typingTick || Date.now();
  const typingNames = (roomState?.typingParticipants ?? [])
    .filter((participant) => participant.clientId !== clientId)
    .filter((participant) => typingReferenceTime - (participant.lastTypedAt ?? 0) < CHAT_TYPING_STALE_MS)
    .map((participant) => participant.name);

  return (
    <main className="room-shell">
      <header className="room-topbar panel">
        <div className="room-brand">
          <span className="room-brand-mark">SyncSpace</span>
          <span className="room-brand-meta">Space {roomId}</span>
        </div>
        <div className="profile-actions">
          <ThemeToggle />
          <button
            className="profile-chip"
            type="button"
            onClick={() => setIsProfileOpen(true)}
            aria-haspopup="dialog"
          >
            <ProfileAvatar viewer={viewer} />
            <span className="profile-chip-copy">
              <span className="profile-chip-label">Profile</span>
              <span className="profile-chip-value">{displayName}</span>
            </span>
          </button>
          <button className="button-secondary" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <section className="room-stage">
        <div className="room-toolbar">
          <div className="room-input-bar panel">
            <input
              id="youtube-url"
              className="input room-url-input"
              type="url"
              placeholder="Paste a YouTube link to sync with the space"
              value={inputUrl}
              onChange={(event) => setInputUrl(event.target.value)}
            />
            <button className="button room-play-button" type="button" onClick={submitVideo}>
              Sync video
            </button>
          </div>
          <div className="room-toolbar-meta">
            <span className="status-pill">
              <span className={`status-dot ${indicatorClass}`} />
              {joinError ?? connectionLabel}
            </span>
            <span className="status-pill">
              <span className="status-dot success" />
              {participants.length}/2 connected
            </span>
            <span className="room-account muted small">
              Signed in as {displayName} - {viewer.email ?? viewer.googleName}
            </span>
            <span className="status-pill">
              <span className={`status-dot ${canControlPlayback ? "success" : ""}`} />
              {roomState?.playbackControllerName
                ? canControlPlayback
                  ? "You control this video"
                  : `${roomState.playbackControllerName} controls this video`
                : "Sync a video to take control"}
            </span>
          </div>
          {inlineError ? <span className="error-text small room-inline-message">{inlineError}</span> : null}
          {inlineNotice ? <span className="small muted room-inline-message">{inlineNotice}</span> : null}
        </div>

        <div className="room-stage-main panel">
          <div className="video-shell">
            <div className="player-stage">
              <div id="youtube-player" />
              {roomState?.videoId && !canControlPlayback ? (
                <div className="video-control-guard" aria-hidden="true" />
              ) : null}
            </div>
            {!roomState?.videoId ? (
              <div className="video-placeholder">
                <div>
                  <h2 style={{ marginTop: 0 }}>Ready for the feature presentation</h2>
                  <p className="muted">Paste a YouTube URL to start the shared screening.</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <section className="room-footer panel">
          <div className="room-footer-head">
              <div>
                <span className="eyebrow">Participants</span>
              <h2 className="room-footer-title">Space participants</h2>
              </div>
              <div className="room-footer-actions">
              <span className="room-link">{shareUrl}</span>
              <button className="button-secondary" type="button" onClick={copyShareUrl}>
                Copy space link
              </button>
            </div>
          </div>
          <div className="participant-list">
            {participants.length === 0 ? (
              <span className="muted small">No participants connected.</span>
            ) : null}
            {participants.map((participant) => (
              <div key={participant.clientId} className="participant-card">
                <div className="participant-main">
                  <span
                    className={`status-dot ${participant.clientId === clientId ? "success" : ""}`}
                  />
                  <span className="participant-name">{participant.name}</span>
                </div>
                <span className="participant-meta">
                  {participant.clientId === clientId ? "You" : "Joined"}
                  {roomState?.ownerClientId === participant.clientId ? " - Admin" : ""}
                </span>
              </div>
            ))}
          </div>
          {roomState?.videoId ? (
            <p className="muted small room-active-video">
              Active video ID: {roomState.videoId}
            </p>
          ) : null}
          {roomState?.videoId && !canControlPlayback ? (
            <p className="muted small room-active-video">
              Viewer mode: {roomState.playbackControllerName ?? "The current controller"} is controlling this
              video. Paste a new YouTube link and press Sync video if you want to take over with your own video.
            </p>
          ) : null}
        </section>
      </section>

      {isProfileOpen ? (
        <section className="modal-backdrop" role="presentation" onClick={() => setIsProfileOpen(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-profile-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">Edit profile</span>
                <h2 id="room-profile-dialog-title">Update your display name</h2>
              </div>
              <button
                className="button-secondary"
                type="button"
                onClick={() => setIsProfileOpen(false)}
              >
                Close
              </button>
            </div>
            <p className="muted">
              Your Google name is the default. Save a different display name if you want it shown
              in the Participants list instead.
            </p>
            <form className="field-stack" onSubmit={saveDisplayName}>
              <label htmlFor="room-display-name">Display name</label>
              <input
                id="room-display-name"
                className="input"
                type="text"
                maxLength={32}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                autoFocus
              />
              <div className="cta-row">
                <button className="button" type="submit" disabled={!draftName.trim()}>
                  Save changes
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}

      <div className={`space-chat-shell${isChatOpen ? " is-open" : ""}`}>
        {isChatOpen ? (
          <section className="space-chat-panel panel" aria-label="Space chat">
            <div className="space-chat-header">
              <div>
                <span className="eyebrow">Space chat</span>
                <h2 className="space-chat-title">Chat while you watch</h2>
              </div>
              <button
                className="button-secondary space-chat-close"
                type="button"
                onClick={() => setIsChatOpen(false)}
              >
                Close
              </button>
            </div>
            <div ref={chatListRef} className="space-chat-list">
              {visibleChatMessages.length === 0 ? (
                <div className="space-chat-empty">
                  <span className="eyebrow">No messages yet</span>
                  <p className="muted">Say hello to everyone in this space.</p>
                </div>
              ) : null}
              {visibleChatMessages.map((message) => {
                const isSelf = message.clientId === clientId;

                return (
                  <article
                    key={message.id}
                    className={`space-chat-message${isSelf ? " is-self" : ""}`}
                  >
                    <ChatAvatar
                      name={message.authorName}
                      image={message.authorImage ?? null}
                    />
                    <div className="space-chat-bubble">
                      <span className="space-chat-author">
                        {isSelf ? "You" : message.authorName}
                      </span>
                      <p>{message.body}</p>
                      {isSelf ? (
                        <span className="space-chat-read-state">
                          {hasBeenSeenByOthers(message, clientId) ? "Seen" : "Delivered"}
                        </span>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="space-chat-footer-row">
              <span className="space-chat-typing">
                {typingNames.length > 0 ? getTypingLabel(typingNames) : "\u00A0"}
              </span>
              <span className="space-chat-unread">
                {unreadCount > 0 && !isChatOpen ? `${unreadCount} unread` : "\u00A0"}
              </span>
            </div>
            <form className="space-chat-compose" onSubmit={submitChatMessage}>
              <input
                className="input"
                type="text"
                value={chatDraft}
                onChange={(event) => {
                  setChatDraft(event.target.value);
                  setTypingState(event.target.value.trim().length > 0);
                }}
                onBlur={() => setTypingState(false)}
                placeholder="Send a message to this space"
                maxLength={400}
              />
              <button className="button" type="submit" disabled={!chatDraft.trim() || isSendingChat}>
                {isSendingChat ? "Sending..." : "Send"}
              </button>
            </form>
          </section>
        ) : null}
        <button
          className="space-chat-launcher"
          type="button"
          onClick={() => setIsChatOpen((current) => !current)}
          aria-expanded={isChatOpen}
          aria-label={isChatOpen ? "Close space chat" : "Open space chat"}
        >
          {unreadCount > 0 ? <span className="space-chat-badge">{unreadCount}</span> : null}
          <svg viewBox="0 0 24 24" aria-hidden="true" className="space-chat-launcher-icon">
            <path
              d="M12 3C7.03 3 3 6.73 3 11.33c0 2.61 1.3 4.94 3.34 6.47V21l3.04-1.67c.84.23 1.72.34 2.62.34 4.97 0 9-3.73 9-8.34S16.97 3 12 3Zm1.05 10.78-2.3-2.46-4.48 2.46 4.94-5.24 2.35 2.46 4.43-2.46-4.94 5.24Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </main>
  );
}

function ProfileAvatar({ viewer }: { viewer: Viewer }) {
  const [imageFailed, setImageFailed] = useState(false);
  const fallback = getProfileInitials(viewer.displayName || viewer.googleName || viewer.email || "U");

  if (viewer.image && !imageFailed) {
    return (
      <span className="profile-avatar">
        <img
          className="profile-avatar-image"
          src={viewer.image}
          alt={`${viewer.displayName} profile`}
          width={36}
          height={36}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return <span className="profile-avatar profile-avatar-fallback">{fallback}</span>;
}

function ChatAvatar({ name, image }: { name: string; image?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const fallback = getProfileInitials(name);

  if (image && !imageFailed) {
    return (
      <span className="space-chat-avatar">
        <img
          className="profile-avatar-image"
          src={image}
          alt={`${name} profile`}
          width={34}
          height={34}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return <span className="space-chat-avatar">{fallback}</span>;
}

function getProfileInitials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "U";
}

function hasBeenSeenByOthers(
  message: { clientId: string; readByClientIds: string[] },
  clientId: string
) {
  return message.readByClientIds.some((readerId) => readerId !== clientId);
}

function getTypingLabel(names: string[]) {
  if (names.length === 1) {
    return `${names[0]} is typing...`;
  }
  return `${names[0]} and ${names.length - 1} other${names.length > 2 ? "s" : ""} are typing...`;
}

function getPresenceMessage(count: number): string {
  if (count >= 2) return "Both participants connected.";
  return "Waiting for the second participant...";
}

function shouldSkipPlaybackApply(input: {
  syncedBy?: string;
  syncEvent?: RoomChannelPayload["syncEvent"];
  clientId: string;
  nextState: RoomStatePayload;
  recentRemotePlayback: {
    action: DirectPlaybackCommandPayload["action"];
    currentTimeSeconds: number;
    videoId?: string | null;
    playbackState: RoomStatePayload["playbackState"];
    issuedAt: number;
  } | null;
}) {
  const isPlaybackEvent =
    input.syncEvent === "video:set" ||
    input.syncEvent === "playback:play" ||
    input.syncEvent === "playback:pause" ||
    input.syncEvent === "playback:seek";

  if (!isPlaybackEvent) {
    return false;
  }

  if (input.syncedBy === input.clientId) {
    return true;
  }

  if (!input.recentRemotePlayback) {
    return false;
  }

  const ageMs = Date.now() - input.recentRemotePlayback.issuedAt;
  if (ageMs > DIRECT_PLAYBACK_DEDUPE_MS) {
    return false;
  }

  const sameAction = input.recentRemotePlayback.action === input.syncEvent;
  const samePlaybackState =
    input.recentRemotePlayback.playbackState === input.nextState.playbackState;
  const sameVideo =
    (input.recentRemotePlayback.videoId ?? input.nextState.videoId) === input.nextState.videoId;
  const sameTime =
    Math.abs(input.recentRemotePlayback.currentTimeSeconds - input.nextState.currentTimeSeconds) <
    PLAYBACK_APPLY_TOLERANCE;

  return sameAction && samePlaybackState && sameVideo && sameTime;
}

function shouldApplyIncomingPlayback(
  previousState: RoomStatePayload | null,
  nextState: RoomStatePayload,
  syncEvent?: RoomChannelPayload["syncEvent"]
) {
  if (!previousState) {
    return true;
  }

  if (
    syncEvent &&
    syncEvent !== "video:set" &&
    syncEvent !== "playback:play" &&
    syncEvent !== "playback:pause" &&
    syncEvent !== "playback:seek"
  ) {
    return false;
  }

  return (
    previousState.playbackSequence !== nextState.playbackSequence ||
    previousState.videoId !== nextState.videoId ||
    previousState.playbackState !== nextState.playbackState ||
    Math.abs(previousState.currentTimeSeconds - nextState.currentTimeSeconds) > PLAYBACK_APPLY_TOLERANCE ||
    previousState.playbackUpdatedAt !== nextState.playbackUpdatedAt
  );
}

function getRoomNotice(roomStatePayload: RoomChannelPayload, clientId: string): string | null {
  const roomState = roomStatePayload.state;
  if (roomStatePayload.syncEvent === "video:set" && roomState.videoId) {
    return `Synced video ${roomState.videoId}`;
  }

  if (roomStatePayload.syncEvent === "participant:update" && roomStatePayload.participantEvent) {
    const actor =
      roomStatePayload.syncedBy === clientId ? "You" : roomStatePayload.participantEvent.name;

    if (roomStatePayload.participantEvent.action === "joined") {
      return `${actor} joined the space.`;
    }
    if (roomStatePayload.participantEvent.action === "left") {
      return `${actor} left the space.`;
    }
    if (roomStatePayload.participantEvent.action === "updated") {
      return roomStatePayload.syncedBy === clientId
        ? "Your display name was updated."
        : `${actor} updated their display name.`;
    }
  }

  return null;
}

function createClientId(): string {
  return crypto.randomUUID();
}

async function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return;
  await new Promise<void>((resolve) => {
    const existingScript = document.querySelector('script[data-youtube-api="true"]');
    if (existingScript) {
      const existingReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        existingReady?.();
        resolve();
      };
      return;
    }
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.dataset.youtubeApi = "true";
    window.onYouTubeIframeAPIReady = () => resolve();
    document.body.appendChild(script);
  });
}

function getExpectedRoomTime(roomState: RoomStatePayload): number {
  if (roomState.playbackState !== "playing") {
    return roomState.currentTimeSeconds;
  }
  const elapsedSeconds = (Date.now() - roomState.playbackUpdatedAt) / 1000;
  return Math.max(0, roomState.currentTimeSeconds + elapsedSeconds);
}

function clampPlaybackTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Number(value.toFixed(2));
}

function shouldEmitHostPlaybackState(
  previous: {
    action: "playback:play" | "playback:pause";
    issuedAt: number;
    currentTimeSeconds: number;
  } | null,
  nextAction: "playback:play" | "playback:pause",
  currentTimeSeconds: number
) {
  if (!previous) {
    return true;
  }

  if (previous.action !== nextAction) {
    return true;
  }

  if (Date.now() - previous.issuedAt > HOST_STATE_EMIT_COOLDOWN_MS) {
    return true;
  }

  return Math.abs(previous.currentTimeSeconds - currentTimeSeconds) > PLAYBACK_APPLY_TOLERANCE;
}
