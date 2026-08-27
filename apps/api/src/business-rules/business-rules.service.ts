import { Injectable } from "@nestjs/common";
import { evaluateApplication, type ApplicationFacts, type DecisionResult } from "@ailyn/business-rules";

@Injectable()
export class BusinessRulesService {
  evaluateApplication(facts: ApplicationFacts): DecisionResult {
    return evaluateApplication(facts);
  }
}
