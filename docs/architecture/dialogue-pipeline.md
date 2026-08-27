# Dialogue Pipeline

1. Receive normalized `InboundMessage`.
2. Save inbound message.
3. Load or create conversation and application.
4. Analyze attachments through `AiProvider.analyzeImage`.
5. Extract structured facts through `AiProvider.extract`.
6. Create a new application when owner or plate changes.
7. Update current facts and append fact history.
8. Evaluate deterministic business rules.
9. Build immutable `ResponsePlan`.
10. Generate natural response through RouterAI.
11. Validate output for forbidden statements, internal leakage, emoji, and informal tone.
12. Persist decision and outbound message.
13. Return channel response.

RouterAI receives runtime context only. It does not receive the whole specification, all acceptance scenarios, or unrestricted message history.
