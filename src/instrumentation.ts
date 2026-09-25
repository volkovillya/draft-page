/** Runs once when a server process starts. Only the Node.js runtime hosts the outbox relay. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./server/outbox/start");
}
