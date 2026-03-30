const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be"
]);

export function extractYouTubeVideoId(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (isValidVideoId(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (!YOUTUBE_HOSTS.has(url.hostname)) {
      return null;
    }

    if (url.hostname.includes("youtu.be")) {
      const candidate = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return isValidVideoId(candidate) ? candidate : null;
    }

    if (url.pathname === "/watch") {
      const candidate = url.searchParams.get("v") ?? "";
      return isValidVideoId(candidate) ? candidate : null;
    }

    if (url.pathname.startsWith("/embed/")) {
      const candidate = url.pathname.split("/")[2] ?? "";
      return isValidVideoId(candidate) ? candidate : null;
    }

    if (url.pathname.startsWith("/shorts/")) {
      const candidate = url.pathname.split("/")[2] ?? "";
      return isValidVideoId(candidate) ? candidate : null;
    }

    if (url.pathname.startsWith("/live/")) {
      const candidate = url.pathname.split("/")[2] ?? "";
      return isValidVideoId(candidate) ? candidate : null;
    }

    return null;
  } catch {
    return null;
  }
}

function isValidVideoId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(value);
}
