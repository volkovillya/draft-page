/** Who is performing an operation. Every core function receives one explicitly. */
export type MemberActor = { kind: "member"; memberId: string; email: string; name: string };

/**
 * The Phase 3 AI worker. It is scoped to the single job it is running: it may add a
 * draft version to `pageId` and post messages to `threadId`, nothing else.
 */
export type AssistantActor = { kind: "assistant"; jobId: string; pageId: string; threadId: string };

export type Actor = MemberActor | AssistantActor;

export const ASSISTANT_DISPLAY_NAME = "Claude";

export const isMember = (actor: Actor): actor is MemberActor => actor.kind === "member";
