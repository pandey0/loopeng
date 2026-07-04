import type { StatusTone } from "@loopeng/ui";
import type { ActivityEvent } from "./api";

export function describeEvent(event: ActivityEvent): string {
  if (event.eventType === "card.moved") {
    const { from, to } = event.payload as { from?: string; to?: string };
    return `moved ${from ?? "?"} → ${to ?? "?"}`;
  }
  if (event.eventType === "card.awaiting_deploy") return "awaiting deploy";
  if (event.eventType === "doc.drift_detected") return "doc drift detected";
  if (event.eventType === "card.epic_reviewed") return "reviewed by tech-manager";
  if (event.eventType === "card.question_raised") {
    const { message } = event.payload as { message?: string };
    return message ?? "question raised";
  }
  return event.eventType;
}

export interface HighSignalToast {
  title: string;
  description: string;
  tone: StatusTone;
}

// Not every event warrants interrupting the user — only the transitions that
// mean "something needs your attention" get a toast. Everything else still
// lands in the bell panel and still invalidates board queries.
export function toHighSignalToast(event: ActivityEvent): HighSignalToast | null {
  if (event.eventType === "card.moved") {
    const { to } = event.payload as { from?: string; to?: string };
    if (to === "blocked") return { title: "Card blocked", description: describeEvent(event), tone: "destructive" };
    if (to === "done") return { title: "Card done", description: describeEvent(event), tone: "success" };
    return null;
  }
  if (event.eventType.startsWith("gate.") && event.eventType.endsWith("failed")) {
    return { title: "Gate failed", description: event.eventType, tone: "destructive" };
  }
  if (event.eventType === "card.question_raised") {
    const { routedTo } = event.payload as { routedTo?: string };
    return { title: routedTo === "tech-manager" ? "Manager review needed" : "Question raised", description: describeEvent(event), tone: "destructive" };
  }
  if (event.eventType.startsWith("deploy.") && event.eventType.includes("live")) {
    return { title: "Deploy live", description: event.eventType, tone: "success" };
  }
  return null;
}
