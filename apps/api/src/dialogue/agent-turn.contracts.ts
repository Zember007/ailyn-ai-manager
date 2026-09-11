import { z } from "@ailyn/schemas";
import type { ApplicationFacts } from "@ailyn/business-rules";

const documentStatus = z.enum(["missing", "received", "poor_quality", "blocked"]);
const knowledgeRequestSchema = z.object({
  /** Transient routing metadata; it is not a durable client-card fact. */
  required: z.boolean(),
  reason: z.enum(["atypical_question", "missing_approved_answer", "out_of_scope"]).optional()
}).strict();
const applicationFactsPatchSchema = z.object({
  language: z.enum(["ru", "kg", "mixed", "unknown"]).optional(), fullName: z.string().min(1).max(200).optional(), phone: z.string().min(3).max(40).optional(),
  citizenship: z.string().max(120).optional(), residenceRegion: z.string().max(160).optional(), residenceText: z.string().max(300).optional(), residenceCategory: z.enum(["BISHKEK_CHUY", "OTHER_KG", "FOREIGN"]).optional(), residenceNeedsClarification: z.boolean().optional(),
  vehicleRegistrationCountry: z.string().max(120).optional(), vehicleRegistrationRegion: z.string().max(120).optional(), vehicleType: z.string().max(120).optional(), vehicleMake: z.string().max(120).optional(), vehicleModel: z.string().max(120).optional(), vehicleYear: z.number().int().min(1900).max(2100).optional(), reportedInvalidVehicleYear: z.number().int().nullable().optional(), vehicleValue: z.number().nonnegative().optional(), requestedAmount: z.number().nonnegative().optional(), requestedMaximumAmount: z.boolean().optional(), vehicleValueSourceCurrency: z.enum(["KGS", "USD", "EUR", "KZT", "RUB"]).optional(), requestedAmountSourceCurrency: z.enum(["KGS", "USD", "EUR", "KZT", "RUB"]).optional(), requestedProgram: z.enum(["without_storage", "parking"]).optional(),
  ownerChanged: z.boolean().optional(), plateChanged: z.boolean().optional(), ownerIsLegalEntity: z.boolean().optional(), borrowerIsLegalEntity: z.boolean().optional(), vehicleInCredit: z.boolean().optional(), vehiclePledged: z.boolean().optional(), vehicleArrested: z.boolean().optional(), registrationRestricted: z.boolean().optional(), refinancingRequested: z.boolean().optional(), buyoutRequested: z.boolean().optional(), accidentNotDrivable: z.boolean().optional(), foreignTravelQuestion: z.boolean().optional(), existingContractQuestion: z.boolean().optional(), existingContractPaymentMessage: z.boolean().optional(), borrowerIsOwner: z.boolean().optional(), ownerCanVisit: z.boolean().optional(),
  familyStatus: z.enum(["married", "single", "divorced", "unknown"]).optional(), vehicleBoughtDuringMarriage: z.boolean().optional(), spouseConsentReady: z.boolean().optional(), spouseConsentAtOffice: z.boolean().optional(), spouseAway: z.boolean().optional(), guarantorAvailable: z.boolean().optional(), guarantorAlternativeDeclined: z.boolean().optional(), documents: z.object({ id_front: documentStatus.optional(), id_back: documentStatus.optional(), vehicle_registration_front: documentStatus.optional(), vehicle_registration_back: documentStatus.optional(), car_photo: documentStatus.optional(), unknown: documentStatus.optional() }).partial().optional(), visitRequested: z.boolean().optional(), visitDate: z.string().max(40).optional(), visitTime: z.string().max(40).optional(), clientPaused: z.boolean().optional(), clientClosed: z.boolean().optional(), declinedDocuments: z.boolean().optional(), documentsProvided: z.boolean().optional(), declinedCarPhoto: z.boolean().optional(), ownerFullName: z.string().max(200).optional(), ownerResidenceRegion: z.string().max(160).optional(), ownerFamilyStatus: z.enum(["married", "single", "divorced", "unknown"]).optional(), vehiclePurchasedDuringMarriage: z.boolean().optional(), divorceCertificateReady: z.boolean().optional(), visitConfirmationPending: z.boolean().optional(), handedToManager: z.boolean().optional(), onTheWay: z.boolean().optional(), arrivedAtOffice: z.boolean().optional(), knowledgeRequest: knowledgeRequestSchema.optional()
}).strict();

export const agentTurnResultSchema = z.object({
  reply: z.string().min(1).max(4000),
  /** A question separated by a semantic yes/no classifier from the same client message. */
  clientQuestion: z.string().min(1).max(1000).optional(),
  /** Transient server-owned marker for an explanation of the active workflow request. */
  activeWorkflowClarification: z.enum(["guarantor"]).optional(),
  /** The client asks why the current stage needs data, without supplying or correcting any fact. Never persisted. */
  currentStageClarification: z.boolean().default(false),
  /** The current client turn explicitly supplies or corrects their residence. Never persisted. */
  residenceStatement: z.boolean().optional(),
  /** The current client turn explicitly chooses a loan programme. Never persisted. */
  programStatement: z.boolean().optional(),
  // This is a routing signal, not a lead-card fact. It lets the orchestrator
  // pay for money normalization only on turns that actually contain a value.
  hasMoney: z.boolean().default(false),
  /** @deprecated Use leadCardPatch.knowledgeRequest; retained for old model replies. */
  needsKnowledgeLookup: z.boolean().default(false),
  language: z.enum(["ru", "kg", "mixed", "unknown"]),
  intent: z.string().min(1).max(120),
  /** Semantic routing for loan limits and rates; it is never a persisted lead fact. */
  loanQuestionKind: z.enum(["none", "maximum_limit", "maximum_preference", "loan_rate", "maximum_limit_and_rate"]),
  /** Semantic choice from an amount-limit alternative; never persisted directly. */
  limitChoice: z.enum(["keep_car", "parking", "undecided"]).optional(),
  leadCardPatch: applicationFactsPatchSchema,
  cardSummary: z.string().max(2000),
  preliminaryLimit: z.number().nonnegative().max(10_000_000).nullable().optional(),
  dialogueState: z.object({
    stage: z.enum(["NEW", "COLLECTING_VEHICLE", "COLLECTING_VALUE", "COLLECTING_AMOUNT", "COLLECTING_RESIDENCE", "ELIGIBILITY_CHECK", "COLLECTING_DOCUMENTS", "COLLECTING_FAMILY_STATUS", "CHECKING_GUARANTOR", "SCHEDULING_VISIT", "TARGET_REACHED_DOCUMENTS", "TARGET_REACHED_VISIT", "REFUSED", "PAUSED", "EXISTING_CONTRACT_REDIRECT"]),
    status: z.enum(["continue", "refuse", "need_more_data", "redirect_existing_contract", "target_reached", "blocked"]),
    nextAction: z.string().min(1).max(120)
  }),
  targetEvent: z.enum(["documents", "visit"]).nullable(),
  managerUpdate: z.object({ kind: z.enum(["none", "initial", "delta"]), changedFields: z.array(z.string().min(1)).max(60) }),
  attachments: z.array(z.object({ attachmentId: z.string().min(1), type: z.enum(["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back", "car", "unknown", "poor_quality"]), status: z.enum(["received", "poor_quality", "blocked"]) })).max(20)
});

export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentLeadCardPatch = Partial<ApplicationFacts>;
export const knowledgeAnswerSchema = z.object({
  reply: z.string().min(1).max(4000),
  answerFound: z.boolean()
}).strict();
export type KnowledgeAnswer = z.infer<typeof knowledgeAnswerSchema>;
export const dialogueSummarySchema = z.object({ summary: z.string().min(1).max(4_000) }).strict();
