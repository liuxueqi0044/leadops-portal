import type { Event, EventType, EnvelopeOnly } from "./schemas.js";
import { EVENT_TYPES } from "./schemas.js";

export type ProjectorHandler = (event: Event, context: ProjectorContext) => Promise<ProjectorResult>;

export interface ProjectorContext {
  organizationId: string;
  clientId?: string;
}

export interface ProjectorResult {
  status: "projected" | "unhandled" | "failed";
  error?: string;
}

export class ProjectorRegistry {
  private handlers = new Map<string, ProjectorHandler>();

  register(eventType: EventType, handler: ProjectorHandler): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`Handler already registered for event type: ${eventType}`);
    }
    this.handlers.set(eventType, handler);
  }

  get(eventType: string): ProjectorHandler | undefined {
    return this.handlers.get(eventType);
  }

  has(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  isKnownType(eventType: string): boolean {
    return (EVENT_TYPES as readonly string[]).includes(eventType);
  }

  async project(envelope: EnvelopeOnly, context: ProjectorContext): Promise<ProjectorResult> {
    const handler = this.handlers.get(envelope.eventType);

    if (!handler) {
      return { status: "unhandled" };
    }

    try {
      const event = envelope as unknown as Event;
      const result = await handler(event, context);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", error: message };
    }
  }
}

export function createProjectorRegistry(): ProjectorRegistry {
  return new ProjectorRegistry();
}
