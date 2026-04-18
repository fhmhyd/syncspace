"use client";

import { signIn } from "next-auth/react";

export default function SyncButton() {
  return (
    <button className="sync-button" type="button" onClick={() => signIn("spotify")}>
      Sync Now
    </button>
  );
}
