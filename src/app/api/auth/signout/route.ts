import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

/**
 * POST /api/auth/signout
 *
 * Destroys the session, which discards the user's GitHub token entirely —
 * there is no server-side copy to clean up.
 *
 * POST rather than GET so a link or prefetch cannot sign someone out.
 */
export async function POST() {
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}
