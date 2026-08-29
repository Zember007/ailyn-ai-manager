import { Injectable } from "@nestjs/common";
import type { DeferredIntegrationResult, FxRateProvider, ManagerNotificationChannel, SpeechToTextProvider, WorkingCalendarProvider } from "./pipeline.contracts.js";

@Injectable()
export class DeferredIntegrationsService implements SpeechToTextProvider, FxRateProvider, WorkingCalendarProvider, ManagerNotificationChannel {
  async transcribe(): Promise<DeferredIntegrationResult<string>> { return { available: false, code: "SPEC_GAP_STT" }; }
  async convertToSom(): Promise<DeferredIntegrationResult<number>> { return { available: false, code: "SPEC_GAP_FX" }; }
  async isWorkingTime(): Promise<DeferredIntegrationResult<boolean>> { return { available: false, code: "SPEC_GAP_CALENDAR" }; }
  async deliver(): Promise<DeferredIntegrationResult<void>> { return { available: false, code: "SPEC_GAP_MANAGER_DELIVERY" }; }
}
