import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/connection";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Liveness probe: no auth, no database (ECS health checks use this).
 * `?db=1` also runs `select 1`, for manual debugging of database connectivity. It reports
 * only ok/not ok, never the error, since this route is unauthenticated.
 */
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("db") !== "1") {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: "ok" }, { headers: NO_STORE });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "health db check failed", err: String(error) }));
    return NextResponse.json({ ok: false, db: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
