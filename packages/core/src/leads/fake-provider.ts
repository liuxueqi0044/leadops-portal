import type {
  QualificationProvider,
  QualificationInput,
  LeadQualification,
  QualificationProviderResponse,
} from "./types.js";

function simpleHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function createDeterministicFakeProvider(): QualificationProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async qualify(
      input: QualificationInput,
    ): Promise<QualificationProviderResponse> {
      const seed = simpleHash(
        `${input.email}|${input.phone}|${input.message}|${input.company}`,
      );
      const score = (seed % 101);
      const confidence = 0.5 + ((seed % 50) / 100);

      let decision: LeadQualification["decision"];
      let suggestedNextAction: LeadQualification["suggestedNextAction"];

      if (score >= 70) {
        decision = "qualified";
        suggestedNextAction = "book_call";
      } else if (score >= 40) {
        decision = "needs_review";
        suggestedNextAction = "request_approval";
      } else {
        decision = "disqualified";
        suggestedNextAction = "discard";
      }

      const name = input.contactName || "Unknown";

      const qualification: LeadQualification = {
        schemaVersion: 1,
        score,
        decision,
        reasons: [
          `Contact ${name} has a score of ${String(score)} based on input analysis.`,
          decision === "qualified"
            ? "Shows strong purchase intent signals."
            : decision === "needs_review"
              ? "Missing some qualifying information."
              : "Insufficient qualification signals.",
        ],
        summary: `Lead from ${input.source || "unknown"} for ${input.serviceNeeded || "unspecified service"} at ${input.company || "unknown company"}.`,
        suggestedNextAction,
        confidence,
        riskFlags: score < 30 ? ["low_engagement"] : [],
      };

      return {
        qualification,
        usage: { input: 0, output: 0 },
        cost: { amountMinor: 0, currency: "USD" },
      };
    },
  };
}

export const fakeProvider: QualificationProvider = createDeterministicFakeProvider();
