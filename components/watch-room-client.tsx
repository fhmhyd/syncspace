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
};

type YouTubeStateChangeEvent = {
  target: YouTubePlayer;
  data: number;
};

type YouTubeApi = {
  Player: new (
    elementId: string,
    options: {
      videoId?: string;
      playerVars?: Record<string, number>;
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: YouTubeStateChangeEvent) => void;
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

const TIME_DRIFT_TOLERANCE = 0.9;
const PLAYBACK_APPLY_TOLERANCE = 0.45;
const SEEK_EMIT_THROTTLE_MS = 900;
const PLAYER_SUPPRESS_MS = 900;
const SEEK_DETECTION_THRESHOLD = 1.6;
const SYNC_INTERVAL_MS = 700;
const CHAT_TYPING_IDLE_MS = 1200;
const PRESENCE_HEARTBEAT_MS = 10_000;

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

  const pusherRef = useRef<Pusher | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const suppressPlayerEventsRef = useRef(false);
  const lastSeekEmitAtRef = useRef(0);
  const knownVideoIdRef = useRef<string | null>(null);
  const joinedRef = useRef(false);
  const roomStateRef = useRef<RoomStatePayload | null>(null);
  const playerReadyRef = useRef(false);
  const lastAppliedPlaybackRef = useRef<{
    videoId: string | null;
    playbackState: RoomStatePayload["playbackState"];
    currentTimeSeconds: number;
    updatedAt: number;
  } | null>(null);
  const playbackSnapshotRef = useRef<{
    currentTimeSeconds: number;
    expectedTimeSeconds: number;
    observedAt: number;
  } | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const typingStopTimeoutRef = useRef<number | null>(null);

  const emitAction = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    try {
      await fetch(`/api/rooms/${roomId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, clientId, ...payload })
      });
    } catch (e) {
      console.error(e);
    }
  }, [roomId, clientId]);

  function runWithSuppressedPlayerEvents(action: () => void) {
    action();
    suppressPlayerEventsRef.current = true;
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, PLAYER_SUPPRESS_MS);
  }

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
    if (Math.abs(localTime - expectedTimeSeconds) > PLAYBACK_APPLY_TOLERANCE) {
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
      updatedAt: nextState.updatedAt
    };
  }, []);

  useEffect(() => {
    setShareUrl(window.location.href);
    setClientId(getOrCreateClientId(roomId));
    setDisplayName(viewer.displayName);
    setDraftName(viewer.displayName);
  }, [roomId, viewer.displayName]);

  useEffect(() => {
    if (!clientId) return;

    let isMounted = true;
    let pusher: Pusher;

    const boot = () => {
      setConnectionLabel("Starting room connection...");

      pusher = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY || "", {
        cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER || "us2",
      });

      pusherRef.current = pusher;
      const channel = pusher.subscribe(`room-${roomId}`);

      channel.bind("room:state", (data: RoomChannelPayload) => {
        if (!isMounted) return;
        joinedRef.current = true;
        const nextState = data.state;
        const previousState = roomStateRef.current;
        roomStateRef.current = nextState;
        setRoomState(nextState);
        setJoinError(null);
        setInlineNotice(getRoomNotice(data, clientId));
        setConnectionLabel(getPresenceMessage(nextState.participants?.length || 0));
        if (shouldApplyIncomingPlayback(previousState, nextState, data.syncEvent)) {
          applyRoomStateToPlayer(nextState);
        }
      });

      channel.bind("room:error", (payload: RoomErrorPayload) => {
        if (!isMounted) return;
        joinedRef.current = false;
        setConnectionLabel("Unable to join room.");
        setJoinError(payload.message);
      });

      pusher.connection.bind("connected", () => {
        if (!isMounted) return;
        setConnectionLabel("Connected. Joining room...");
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
        setConnectionLabel("Room connection failed. Retrying...");
        setJoinError("Could not connect to the room server yet. Retrying...");
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
    };
  }, [applyRoomStateToPlayer, clientId, displayName, roomId, viewer.image, emitAction, emitLeaveRequest]);

  useEffect(() => {
    let cancelled = false;

    void loadYouTubeApi().then(() => {
      if (cancelled || playerRef.current || !window.YT) {
        return;
      }

      playerRef.current = new window.YT.Player("youtube-player", {
        playerVars: {
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: () => {
            playerReadyRef.current = true;
            if (roomStateRef.current) {
              applyRoomStateToPlayer(roomStateRef.current);
            }
          },
          onStateChange: (event) => {
            if (
              !joinedRef.current ||
              suppressPlayerEventsRef.current ||
              !playerReadyRef.current ||
              typeof event.target.getCurrentTime !== "function"
            ) {
              return;
            }

            const currentTimeSeconds = event.target.getCurrentTime();
            if (event.data === window.YT?.PlayerState.PLAYING) {
              emitAction("playback:play", { currentTimeSeconds });
            } else if (event.data === window.YT?.PlayerState.PAUSED) {
              emitAction("playback:pause", { currentTimeSeconds });
            }
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
  }, [applyRoomStateToPlayer, emitAction]);

  useEffect(() => {
    if (!playerRef.current || !joinedRef.current || !playerReadyRef.current) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (
        !roomState ||
        !playerRef.current ||
        suppressPlayerEventsRef.current ||
        typeof playerRef.current.getCurrentTime !== "function"
      ) {
        return;
      }

      const currentTimeSeconds = playerRef.current.getCurrentTime();
      const expectedTimeSeconds = getExpectedRoomTime(roomState);
      const now = Date.now();
      const driftSeconds = Math.abs(currentTimeSeconds - expectedTimeSeconds);

      if (roomState.playbackState === "playing") {
        if (driftSeconds > TIME_DRIFT_TOLERANCE) {
          runWithSuppressedPlayerEvents(() => {
            playerRef.current?.seekTo(expectedTimeSeconds, true);
            playerRef.current?.playVideo();
          });
        }

        const previousSnapshot = playbackSnapshotRef.current;
        if (previousSnapshot && now - lastSeekEmitAtRef.current >= SEEK_EMIT_THROTTLE_MS) {
          const actualDelta = currentTimeSeconds - previousSnapshot.currentTimeSeconds;
          const expectedDelta = expectedTimeSeconds - previousSnapshot.expectedTimeSeconds;

          if (Math.abs(actualDelta - expectedDelta) > SEEK_DETECTION_THRESHOLD) {
            lastSeekEmitAtRef.current = now;
            emitAction("playback:seek", { currentTimeSeconds });
          }
        }
      } else if (driftSeconds > 0.35) {
        runWithSuppressedPlayerEvents(() => {
          playerRef.current?.seekTo(expectedTimeSeconds, true);
          playerRef.current?.pauseVideo();
        });
      }

      playbackSnapshotRef.current = {
        currentTimeSeconds,
        expectedTimeSeconds,
        observedAt: now
      };
    }, SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      playbackSnapshotRef.current = null;
    };
  }, [clientId, roomId, roomState, emitAction]);

  useEffect(() => {
    if (!roomState || !playerRef.current || !playerReadyRef.current) {
      return;
    }

    const previousApplied = lastAppliedPlaybackRef.current;
    roomStateRef.current = roomState;
    if (
      !previousApplied ||
      previousApplied.videoId !== roomState.videoId ||
      previousApplied.playbackState !== roomState.playbackState ||
      Math.abs(previousApplied.currentTimeSeconds - roomState.currentTimeSeconds) > PLAYBACK_APPLY_TOLERANCE ||
      previousApplied.updatedAt !== roomState.updatedAt
    ) {
      applyRoomStateToPlayer(roomState);
    }
  }, [applyRoomStateToPlayer, roomState]);

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

    emitAction("chat:read", { messageId: latestUnread.id });
  }, [clientId, isChatOpen, roomState?.chatMessages, emitAction]);

  useEffect(() => {
    return () => {
      if (typingStopTimeoutRef.current !== null) {
        window.clearTimeout(typingStopTimeoutRef.current);
      }
    };
  }, []);

  function submitVideo() {
    if (!joinedRef.current) {
      setInlineNotice(null);
      setInlineError("Room is still connecting. Wait for the room status to show connected.");
      return;
    }

    const videoId = extractYouTubeVideoId(inputUrl);
    if (!videoId) {
      setInlineNotice(null);
      setInlineError("Enter a valid YouTube URL.");
      return;
    }

    setInlineError(null);
    setInlineNotice("Sending video to the room...");
    emitAction("video:set", { videoId });
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
    setInlineNotice("Updated your display name. Refreshing room presence...");
    setIsProfileOpen(false);

    joinedRef.current = false;
    setJoinError(null);
    setConnectionLabel("Refreshing your room profile...");
    emitAction("room:join", {
      displayName: storedName,
      image: viewer.image ?? null
    });
  }

  function submitChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = chatDraft.trim();
    if (!value || !joinedRef.current) {
      return;
    }

    setTypingState(false);
    emitAction("chat:message", { body: value });
    setChatDraft("");
    setIsChatOpen(true);
  }

  function setTypingState(isTyping: boolean) {
    if (!joinedRef.current) {
      return;
    }

    emitAction("chat:typing", { isTyping });

    if (typingStopTimeoutRef.current !== null) {
      window.clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }

    if (isTyping) {
      typingStopTimeoutRef.current = window.setTimeout(() => {
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
  const typingNames = (roomState?.typingParticipants ?? [])
    .filter((participant) => participant.clientId !== clientId)
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
          </div>
          {inlineError ? <span className="error-text small room-inline-message">{inlineError}</span> : null}
          {inlineNotice ? <span className="small muted room-inline-message">{inlineNotice}</span> : null}
        </div>

        <div className="room-stage-main panel">
          <div className="video-shell">
            <div className="player-stage">
              <div id="youtube-player" />
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
                placeholder="Send a message to this space"
                maxLength={400}
              />
              <button className="button" type="submit" disabled={!chatDraft.trim()}>
                Send
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
    previousState.videoId !== nextState.videoId ||
    previousState.playbackState !== nextState.playbackState ||
    Math.abs(previousState.currentTimeSeconds - nextState.currentTimeSeconds) > PLAYBACK_APPLY_TOLERANCE ||
    previousState.updatedAt !== nextState.updatedAt
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
      return `${actor} joined the room.`;
    }
    if (roomStatePayload.participantEvent.action === "left") {
      return `${actor} left the room.`;
    }
    if (roomStatePayload.participantEvent.action === "updated") {
      return roomStatePayload.syncedBy === clientId
        ? "Your display name was updated."
        : `${actor} updated their display name.`;
    }
  }

  return null;
}

function getOrCreateClientId(roomId: string): string {
  const roomKey = `syncscreen:${roomId}:client`;
  const nameKeyPrefix = "syncscreen-client:";

  if (window.name.startsWith(nameKeyPrefix)) {
    const existingFromWindow = window.name.slice(nameKeyPrefix.length);
    window.sessionStorage.setItem(roomKey, existingFromWindow);
    return existingFromWindow;
  }

  const existingFromSession = window.sessionStorage.getItem(roomKey);
  if (existingFromSession) {
    window.name = `${nameKeyPrefix}${existingFromSession}`;
    return existingFromSession;
  }

  const nextId = crypto.randomUUID();
  window.sessionStorage.setItem(roomKey, nextId);
  window.name = `${nameKeyPrefix}${nextId}`;
  return nextId;
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
  const elapsedSeconds = (Date.now() - roomState.updatedAt) / 1000;
  return Math.max(0, roomState.currentTimeSeconds + elapsedSeconds);
}
