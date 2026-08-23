import { describe, it, expect } from "vitest";
import {
  canTransition,
  transitionOrThrow,
  isTerminal,
  assertIsValidStatus,
  getLegalCommands,
  canApplyQualificationDecision,
  StateMachineError,
} from "./state-machine.js";
import type { LeadStatus, LeadCommand } from "./types.js";

describe("Lead State Machine", () => {
  describe("canTransition - legal transitions", () => {
    const legalCases: [LeadStatus, LeadCommand, LeadStatus][] = [
      ["received", "qualify", "qualified"],
      ["received", "needs_review", "needs_review"],
      ["received", "archive", "archived"],
      ["qualified", "approve", "approved"],
      ["qualified", "reject", "rejected"],
      ["qualified", "archive", "archived"],
      ["needs_review", "approve", "approved"],
      ["needs_review", "reject", "rejected"],
      ["needs_review", "archive", "archived"],
      ["approved", "convert", "converted"],
      ["approved", "archive", "archived"],
      ["rejected", "archive", "archived"],
    ];

    for (const [from, command, to] of legalCases) {
      it(`${from} -> ${command} -> ${to}`, () => {
        const result = canTransition(from, command);
        expect(result.allowed).toBe(true);
        if (result.allowed) expect(result.to).toBe(to);
      });
    }
  });

  describe("canTransition - illegal transitions", () => {
    const illegalCases: [LeadStatus, LeadCommand][] = [
      // received cannot approve
      ["received", "approve"],
      ["received", "reject"],
      ["received", "convert"],
      // qualified cannot qualify again
      ["qualified", "qualify"],
      ["qualified", "needs_review"],
      ["qualified", "convert"],
      // needs_review cannot qualify directly
      ["needs_review", "qualify"],
      ["needs_review", "convert"],
      // approved cannot go back
      ["approved", "qualify"],
      ["approved", "needs_review"],
      ["approved", "approve"],
      ["approved", "reject"],
      // rejected cannot be approved
      ["rejected", "approve"],
      ["rejected", "qualify"],
      ["rejected", "needs_review"],
      ["rejected", "convert"],
      // converted cannot do anything
      ["converted", "qualify"],
      ["converted", "approve"],
      ["converted", "reject"],
      ["converted", "convert"],
      ["converted", "archive"],
      ["converted", "needs_review"],
      // archived cannot do anything
      ["archived", "qualify"],
      ["archived", "approve"],
      ["archived", "reject"],
      ["archived", "convert"],
      ["archived", "archive"],
      ["archived", "needs_review"],
    ];

    for (const [from, command] of illegalCases) {
      it(`${from} -> ${command} should NOT be allowed`, () => {
        const result = canTransition(from, command);
        expect(result.allowed).toBe(false);
      });
    }
  });

  describe("transitionOrThrow", () => {
    it("returns target status for legal transition", () => {
      expect(transitionOrThrow("received", "qualify")).toBe("qualified");
    });

    it("throws StateMachineError for illegal transition", () => {
      expect(() => transitionOrThrow("converted", "qualify")).toThrow(
        StateMachineError,
      );
    });

    it("includes error code in StateMachineError", () => {
      try {
        transitionOrThrow("archived", "qualify");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(StateMachineError);
        expect((e as StateMachineError).code).toBe("INVALID_TRANSITION");
      }
    });
  });

  describe("isTerminal", () => {
    it("converted is terminal", () => { expect(isTerminal("converted")).toBe(true); });
    it("archived is terminal", () => { expect(isTerminal("archived")).toBe(true); });
    it("rejected is NOT terminal", () => { expect(isTerminal("rejected")).toBe(false); });
    it("received is NOT terminal", () => { expect(isTerminal("received")).toBe(false); });
    it("qualified is NOT terminal", () => { expect(isTerminal("qualified")).toBe(false); });
  });

  describe("assertIsValidStatus", () => {
    it("accepts valid statuses", () => {
      expect(() => { assertIsValidStatus("received"); }).not.toThrow();
      expect(() => { assertIsValidStatus("qualified"); }).not.toThrow();
      expect(() => { assertIsValidStatus("converted"); }).not.toThrow();
    });

    it("throws for invalid status", () => {
      expect(() => { assertIsValidStatus("invalid_status"); }).toThrow(
        StateMachineError,
      );
    });
  });

  describe("getLegalCommands", () => {
    it("lists available commands from received", () => {
      const cmds = getLegalCommands("received");
      expect(cmds).toContain("qualify");
      expect(cmds).toContain("needs_review");
      expect(cmds).toContain("archive");
      expect(cmds.length).toBe(3);
    });

    it("lists available commands from approved", () => {
      const cmds = getLegalCommands("approved");
      expect(cmds).toContain("convert");
      expect(cmds).toContain("archive");
      expect(cmds.length).toBe(2);
    });

    it("returns empty for terminal statuses", () => {
      expect(getLegalCommands("converted").length).toBe(0);
      expect(getLegalCommands("archived").length).toBe(0);
    });
  });

  describe("canApplyQualificationDecision", () => {
    it("maps qualified to qualify command", () => {
      expect(canApplyQualificationDecision("received", "qualified")).toBe(
        "qualify",
      );
    });

    it("maps needs_review to needs_review command", () => {
      expect(canApplyQualificationDecision("received", "needs_review")).toBe(
        "needs_review",
      );
    });

    it("maps disqualified to archive command", () => {
      expect(canApplyQualificationDecision("received", "disqualified")).toBe(
        "archive",
      );
    });
  });
});
