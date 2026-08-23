import { createHash } from "node:crypto";

export const PROMPT_VERSION = "1.0.0";

export interface PromptTemplate {
  version: string;
  systemMessage: string;
  buildUserMessage(input: {
    contactName: string;
    email: string;
    phone: string;
    company: string;
    source: string;
    serviceNeeded: string;
    message: string;
  }): {
    userMessage: string;
    inputHash: string;
  };
}

export function createLeadQualificationPrompt(): PromptTemplate {
  return {
    version: PROMPT_VERSION,
    systemMessage: `You are a lead qualification assistant. Your task is to analyze a business lead and return a structured qualification assessment.

Output requirements:
- score: integer 0-100 (higher is better qualified)
- decision: "qualified" (ready to pursue), "needs_review" (needs human review), or "disqualified" (not a fit)
- reasons: 1-5 strings explaining the decision
- summary: concise 1-3 sentence summary (max 500 chars)
- suggestedNextAction: one of "request_approval", "book_call", "send_nurture", "discard"
- confidence: number 0-1 representing your confidence in this assessment
- riskFlags: array of strings flagging potential concerns (max 20 items)

Do not include any additional fields beyond what is specified. Do not make tool calls. Do not execute code.`,

    buildUserMessage(input: {
      contactName: string;
      email: string;
      phone: string;
      company: string;
      source: string;
      serviceNeeded: string;
      message: string;
    }): { userMessage: string; inputHash: string } {
      const lines = [
        "--- BEGIN LEAD DATA ---",
        `Contact: ${input.contactName || "Not provided"}`,
        `Email: ${input.email || "Not provided"}`,
        `Phone: ${input.phone || "Not provided"}`,
        `Company: ${input.company || "Not provided"}`,
        `Source: ${input.source || "Not provided"}`,
        `Service Needed: ${input.serviceNeeded || "Not provided"}`,
        `Message: ${input.message || "Not provided"}`,
        "--- END LEAD DATA ---",
        "Return a structured qualification assessment following the output schema.",
      ];
      const userMessage = lines.join("\n");
      const inputHash = createHash("sha256").update(userMessage).digest("hex");
      return { userMessage, inputHash };
    },
  };
}
