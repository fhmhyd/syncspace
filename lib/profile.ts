import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";

export const PROFILE_NAME_KEY_PREFIX = "syncscreen:profile:name:";
export const PROFILE_NAME_COOKIE_PREFIX = "syncscreen_profile_name_";
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 365;
const PROFILE_NAME_MAX_LENGTH = 32;

export function normalizeProfileName(value: string): string {
  return value.trim().slice(0, PROFILE_NAME_MAX_LENGTH);
}

export function getStoredProfileName(userId: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  const storageKey = getProfileStorageKey(userId);
  const cookieName = getProfileCookieName(userId);
  const localName = normalizeProfileName(window.localStorage.getItem(storageKey) ?? "");
  if (localName) {
    syncNameCookie(cookieName, localName);
    return localName;
  }

  const savedName = normalizeProfileName(readCookie(cookieName));
  if (savedName) {
    window.localStorage.setItem(storageKey, savedName);
    return savedName;
  }

  return "";
}

export function saveStoredProfileName(userId: string, name: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  const trimmedName = normalizeProfileName(name);
  if (!trimmedName) {
    return "";
  }

  const storageKey = getProfileStorageKey(userId);
  const cookieName = getProfileCookieName(userId);
  window.localStorage.setItem(storageKey, trimmedName);
  syncNameCookie(cookieName, trimmedName);
  return trimmedName;
}

export function getProfileNameFromCookieStore(
  cookieStore: Pick<ReadonlyRequestCookies, "get">,
  userId: string,
  fallbackName: string
): string {
  const fromCookie = normalizeProfileName(
    cookieStore.get(getProfileCookieName(userId))?.value ?? ""
  );
  return fromCookie || normalizeProfileName(fallbackName);
}

export function getProfileNameFromCookieHeader(
  cookieHeader: string | undefined,
  userId: string,
  fallbackName: string
): string {
  if (!cookieHeader) {
    return normalizeProfileName(fallbackName);
  }

  const cookieName = getProfileCookieName(userId);
  const cookieValue = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  const fromCookie = normalizeProfileName(cookieValue ? decodeURIComponent(cookieValue) : "");
  return fromCookie || normalizeProfileName(fallbackName);
}

function syncNameCookie(cookieName: string, name: string) {
  document.cookie = `${cookieName}=${encodeURIComponent(name)}; path=/; max-age=${COOKIE_TTL_SECONDS}; samesite=lax`;
}

function readCookie(name: string): string {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function getProfileStorageKey(userId: string): string {
  return `${PROFILE_NAME_KEY_PREFIX}${userId}`;
}

function getProfileCookieName(userId: string): string {
  return `${PROFILE_NAME_COOKIE_PREFIX}${sanitizeUserId(userId)}`;
}

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
