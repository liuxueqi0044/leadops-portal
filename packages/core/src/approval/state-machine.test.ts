import { describe, it, expect } from "vitest";
import {
  canTransitionApproval,
  isApprovalTerminal,
  assertCanTransitionApproval,
  ApprovalStateMachineError,
  type ApprovalStatus,
} from "@leadops/core";

describe("approval state machine", () => {
  describe("canTransitionApproval", () => {
    it("allows pending to approved", () => {
      expect(canTransitionApproval("pending", "approved")).toBe(true);
    });
    it("allows pending to rejected", () => {
      expect(canTransitionApproval("pending", "rejected")).toBe(true);
    });
    it("allows pending to expired", () => {
      expect(canTransitionApproval("pending", "expired")).toBe(true);
    });
    it("allows pending to cancelled", () => {
      expect(canTransitionApproval("pending", "cancelled")).toBe(true);
    });
    it("rejects approved to any other status", () => {
      for (const to of ["pending", "rejected", "expired", "cancelled"] as ApprovalStatus[]) {
        expect(canTransitionApproval("approved", to)).toBe(false);
      }
    });
    it("rejects rejected to any other status", () => {
      for (const to of ["pending", "approved", "expired", "cancelled"] as ApprovalStatus[]) {
        expect(canTransitionApproval("rejected", to)).toBe(false);
      }
    });
    it("rejects expired to any other status", () => {
      for (const to of ["pending", "approved", "rejected", "cancelled"] as ApprovalStatus[]) {
        expect(canTransitionApproval("expired", to)).toBe(false);
      }
    });
    it("rejects cancelled to any other status", () => {
      for (const to of ["pending", "approved", "rejected", "expired"] as ApprovalStatus[]) {
        expect(canTransitionApproval("cancelled", to)).toBe(false);
      }
    });
  });

  describe("isApprovalTerminal", () => {
    it("pending is not terminal", () => {
      expect(isApprovalTerminal("pending")).toBe(false);
    });
    it("approved is terminal", () => {
      expect(isApprovalTerminal("approved")).toBe(true);
    });
    it("rejected is terminal", () => {
      expect(isApprovalTerminal("rejected")).toBe(true);
    });
    it("expired is terminal", () => {
      expect(isApprovalTerminal("expired")).toBe(true);
    });
    it("cancelled is terminal", () => {
      expect(isApprovalTerminal("cancelled")).toBe(true);
    });
  });

  describe("assertCanTransitionApproval", () => {
    it("does not throw for valid transitions", () => {
      expect(() => { assertCanTransitionApproval("pending", "approved"); }).not.toThrow();
    });
    it("throws ApprovalStateMachineError for invalid transitions", () => {
      expect(() => { assertCanTransitionApproval("approved", "rejected"); }).toThrow(
        ApprovalStateMachineError,
      );
    });
    it("throws with correct code for invalid transitions", () => {
      try {
        assertCanTransitionApproval("approved", "pending");
      } catch (err) {
        expect(err).toBeInstanceOf(ApprovalStateMachineError);
        expect((err as ApprovalStateMachineError).code).toBe("ILLEGAL_TRANSITION");
      }
    });
  });
});
