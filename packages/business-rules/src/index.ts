export type BusinessRuleStatus = "not_configured" | "eligible" | "ineligible" | "needs_review";

export interface ApplicationFacts {
  monthlyIncome?: number;
  requestedAmount?: number;
  employmentStatus?: string;
  region?: string;
  metadata?: Record<string, unknown>;
}

export interface RuleEvaluationResult {
  status: BusinessRuleStatus;
  reasons: string[];
  limits?: {
    minAmount?: number;
    maxAmount?: number;
  };
  availablePrograms: string[];
}

const missingRulesResult: RuleEvaluationResult = {
  status: "not_configured",
  reasons: ["Business rules specification is not configured yet."],
  availablePrograms: []
};

export function evaluateEligibility(_facts: ApplicationFacts): RuleEvaluationResult {
  return missingRulesResult;
}

export function calculateLoanLimits(_facts: ApplicationFacts): RuleEvaluationResult["limits"] {
  return undefined;
}

export function determineAvailablePrograms(_facts: ApplicationFacts): string[] {
  return [];
}

export function evaluateRefusalReasons(_facts: ApplicationFacts): string[] {
  return [];
}

export function evaluateApplication(facts: ApplicationFacts): RuleEvaluationResult {
  return {
    ...evaluateEligibility(facts),
    limits: calculateLoanLimits(facts),
    availablePrograms: determineAvailablePrograms(facts),
    reasons: evaluateRefusalReasons(facts).length
      ? evaluateRefusalReasons(facts)
      : missingRulesResult.reasons
  };
}
