import { Injectable } from "@nestjs/common";
import { evaluateApplication, type ApplicationFacts, type RuleEvaluationResult } from "@ailyn/business-rules";

@Injectable()
export class BusinessRulesService {
  evaluateApplication(facts: ApplicationFacts): RuleEvaluationResult {
    return evaluateApplication(facts);
  }
}
