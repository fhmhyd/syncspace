"use client";

import { FormEvent, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { saveStoredProfileName } from "@/lib/profile";
import ThemeToggle from "@/components/theme-toggle";

type Viewer = {
  id: string;
  email?: string | null;
  image?: string | null;
  googleName: string;
  displayName: string;
};

type Props = {
  callbackUrl: string;
  viewer: Viewer | null;
  initialRooms: {
    roomId: string;
    title: string;
    ownerName: string;
    ownerUserId: string;
    updatedAt: number;
    createdAt: number;
    participants: Array<{
      clientId: string;
      name: string;
      image?: string | null;
      socketId: string;
      joinedAt: number;
    }>;
  }[];
};

export default function HomeClient({ callbackUrl, viewer, initialRooms }: Props) {
  const [rooms, setRooms] = useState(initialRooms);
  const [isCreating, setIsCreating] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(viewer?.displayName ?? "");
  const [draftName, setDraftName] = useState(viewer?.displayName ?? "");
  const [roomTitle, setRoomTitle] = useState("");

  async function createRoom() {
    if (!viewer) {
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: roomTitle
        })
      });

      const payload = (await response.json()) as {
        roomId?: string;
        title?: string;
        ownerName?: string;
        ownerUserId?: string;
        updatedAt?: number;
        createdAt?: number;
        participants?: {
          clientId: string;
          name: string;
          image?: string | null;
          socketId: string;
          joinedAt: number;
        }[];
        error?: string;
      };
      if (!response.ok || !payload?.roomId) {
        throw new Error(payload?.error ?? "Failed to create a room.");
      }

      const nextRoomId = payload.roomId;

      setRooms((currentRooms) => [
        {
          roomId: nextRoomId,
          title: payload.title ?? roomTitle.trim(),
          ownerName: payload.ownerName ?? displayName,
          ownerUserId: payload.ownerUserId ?? viewer.id,
          updatedAt: payload.updatedAt ?? Date.now(),
          createdAt: payload.createdAt ?? Date.now(),
          participants: payload.participants ?? []
        },
        ...currentRooms
      ]);
      setRoomTitle("");
      setIsCreateRoomOpen(false);
      window.location.href = `/room/${nextRoomId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create a room.");
    } finally {
      setIsCreating(false);
    }
  }

  function submitDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewer) {
      return;
    }

    setIsSavingName(true);
    const storedName = saveStoredProfileName(viewer.id, draftName);
    setDisplayName(storedName);
    setDraftName(storedName);
    window.setTimeout(() => {
      setIsSavingName(false);
      setIsProfileOpen(false);
    }, 250);
  }

  if (!viewer) {
    return (
      <main className="landing-shell">
        <section className="landing-stage">
          <div className="landing-orb landing-orb-a" />
          <div className="landing-orb landing-orb-b" />
          <div className="landing-orb landing-orb-c" />
          <div className="landing-grid" />
          <div className="landing-copy">
            <span className="eyebrow">Private watch spaces for two</span>
            <span className="landing-wordmark">SyncSpace</span>
            <h1>Watch together without drifting apart.</h1>
            <p>
              Sign in with Google, open a private space, sync the same YouTube video, and keep
              chat and playback aligned in real time.
            </p>
            <div className="landing-action-row">
              <button
                className="button landing-primary-cta"
                type="button"
                onClick={() => void signIn("google", { callbackUrl })}
              >
                Sign up with Google
              </button>
              <button
                className="button-secondary landing-secondary-cta"
                type="button"
                onClick={() => void signIn("google", { callbackUrl })}
              >
                Log in
              </button>
            </div>
            <div className="landing-meta-row">
              <span className="landing-meta-pill">Synced playback</span>
              <span className="landing-meta-pill">Live chat</span>
              <span className="landing-meta-pill">2-person spaces</span>
            </div>
            <div className="landing-scene" aria-hidden="true">
              <div className="landing-scene-screen">
                <div className="landing-scene-glow" />
                <div className="landing-scene-bar" />
                <div className="landing-scene-lines">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="landing-scene-chat landing-scene-chat-left">play at 1:24</div>
              <div className="landing-scene-chat landing-scene-chat-right">synced</div>
              <div className="landing-scene-avatar landing-scene-avatar-left">
                <img src="/landing/girl.avif" alt="" />
              </div>
              <div className="landing-scene-avatar landing-scene-avatar-right">
                <img src="/landing/boy.avif" alt="" />
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const signedInViewer = viewer;

  return (
    <main className="home-shell">
      <header className="home-topbar panel">
        <div className="room-brand">
          <span className="room-brand-mark">SyncScreen</span>
          <span className="room-brand-meta">All rooms</span>
        </div>
        <div className="profile-actions">
          <ThemeToggle />
          <button
            className="profile-chip"
            type="button"
            onClick={() => setIsProfileOpen(true)}
            aria-haspopup="dialog"
          >
            <ProfileAvatar viewer={signedInViewer} />
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

      <section className="home-content">
        <div className="home-actions">
          <button className="button" type="button" onClick={() => setIsCreateRoomOpen(true)}>
            Create room
          </button>
        </div>
        {error ? <p className="error-text small home-error">{error}</p> : null}
        {rooms.length === 0 ? (
          <section className="panel home-empty-state">
            <span className="eyebrow">No rooms yet</span>
            <h2>Start the first room</h2>
            <p className="muted">
              Create a room with a title and it will appear here for everyone who signs in.
            </p>
          </section>
        ) : (
          <section className="room-card-grid">
            {rooms.map((room) => {
              const ownerParticipant = room.participants.find(
                (participant) => participant.name === room.ownerName
              );

              return (
                <a key={room.roomId} className="room-card panel" href={`/room/${room.roomId}`}>
                  <div className="room-card-head">
                    <div className="room-card-owner-group">
                      <ParticipantAvatar
                        name={room.ownerName}
                        image={ownerParticipant?.image ?? null}
                        size="small"
                      />
                      <span className="room-card-owner-copy">
                        <span className="room-card-owner-label">Hosted by</span>
                        <span className="room-card-owner">{room.ownerName}</span>
                      </span>
                    </div>
                    <span className="room-card-state">
                      {room.participants.length >= 2 ? "Full room" : "Open seat"}
                    </span>
                  </div>
                  <div className="room-card-body">
                    <div className="room-card-title-stack">
                      <strong>{room.title}</strong>
                      <span>Click to join the room</span>
                    </div>
                    <div className="room-card-presence">
                      {Array.from({ length: 2 }).map((_, index) => {
                        const participant = room.participants[index];

                        return (
                          <div key={`${room.roomId}-seat-${index}`} className="room-seat">
                            <ParticipantAvatar
                              name={participant?.name ?? `Seat ${index + 1}`}
                              image={participant?.image ?? null}
                              empty={!participant}
                              size="large"
                            />
                            <span className="room-seat-name">
                              {participant?.name ?? "Waiting for someone"}
                            </span>
                            <span className="room-seat-meta">
                              {participant ? "Joined" : "Open seat"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="room-card-meta">
                    <span>{room.participants.length}/2 connected</span>
                    <span>{room.ownerUserId === signedInViewer.id ? "Your room" : "Join room"}</span>
                  </div>
                </a>
              );
            })}
          </section>
        )}
      </section>

      {isProfileOpen ? (
        <section className="modal-backdrop" role="presentation" onClick={() => setIsProfileOpen(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">Edit profile</span>
                <h2 id="profile-dialog-title">Choose your display name</h2>
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
              This is the name people will see in your rooms. By default, we use your Google name.
            </p>
            <form className="field-stack" onSubmit={submitDisplayName}>
              <label htmlFor="display-name">Display name</label>
              <input
                id="display-name"
                className="input"
                type="text"
                maxLength={32}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                autoFocus
              />
              <div className="cta-row">
                <button className="button" type="submit" disabled={!draftName.trim()}>
                  {isSavingName ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}

      {isCreateRoomOpen ? (
        <section className="modal-backdrop" role="presentation" onClick={() => setIsCreateRoomOpen(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-room-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">Create room</span>
                <h2 id="create-room-dialog-title">Name your room</h2>
              </div>
              <button
                className="button-secondary"
                type="button"
                onClick={() => setIsCreateRoomOpen(false)}
              >
                Close
              </button>
            </div>
            <p className="muted">
              Pick a room title. The room will appear on the home page and open right after you
              create it.
            </p>
            <form
              className="field-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void createRoom();
              }}
            >
              <label htmlFor="room-title">Room title</label>
              <input
                id="room-title"
                className="input"
                type="text"
                maxLength={48}
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.target.value)}
                placeholder="Movie night"
                autoFocus
              />
              <div className="cta-row">
                <button className="button" type="submit" disabled={!roomTitle.trim() || isCreating}>
                  {isCreating ? "Creating room..." : "Create room"}
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}
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

function ParticipantAvatar({
  name,
  image,
  empty = false,
  size
}: {
  name: string;
  image?: string | null;
  empty?: boolean;
  size: "small" | "large";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const className = `room-participant-avatar room-participant-avatar-${size}${empty ? " is-empty" : ""}`;

  if (image && !imageFailed && !empty) {
    return (
      <span className={className}>
        <img
          className="profile-avatar-image"
          src={image}
          alt={`${name} profile`}
          width={size === "small" ? 40 : 74}
          height={size === "small" ? 40 : 74}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return <span className={className}>{empty ? "+" : getProfileInitials(name)}</span>;
}

function getProfileInitials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "U";
}
