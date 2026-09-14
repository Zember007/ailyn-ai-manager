/**
 * A question about somebody else's vehicle is an FAQ, not a correction of
 * the current applicant's lead card. This narrow fallback intentionally
 * requires either an explicit third-person possessive or a relationship plus
 * a vehicle reference, so an ordinary correction of the client's own car is
 * not discarded.
 */
export function referencesOtherPersonsVehicle(text: string | undefined): boolean {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  if (!normalized) return false;
  const thirdPersonPossessive = /(?:^|[^\p{L}])(?:у\s+(?:не[гё]о|них)|его|е[её]|их)\s+(?:\p{L}+\s+){0,3}(?:авто|автомобил\p{L}*|машин\p{L}*|тойот\p{L}*|королл\p{L}*|камр\p{L}*)/iu.test(normalized);
  const relationship = /(?:^|[^\p{L}])(?:брат(?:ишк\p{L}*)?|сестр\p{L}*|друг\p{L}*|знаком\p{L}*|родственник\p{L}*|муж\p{L}*|жен\p{L}*|отец|пап\p{L}*|мам\p{L}*)(?=$|[^\p{L}])/iu.test(normalized);
  const vehicleReference = /(?:авто|автомобил\p{L}*|машин\p{L}*|тойот\p{L}*|королл\p{L}*|камр\p{L}*)/iu.test(normalized);
  return thirdPersonPossessive || (relationship && vehicleReference);
}

export function removeOtherPersonsVehicleFacts<T extends Record<string, unknown>>(patch: T): T {
  const result = { ...patch };
  for (const key of [
    "vehicleMake", "vehicleModel", "vehicleYear", "vehicleValue", "vehicleValueSourceCurrency",
    "vehicleRegistrationCountry", "vehicleRegistrationRegion", "vehicleType",
    "requestedAmount", "requestedAmountSourceCurrency", "requestedProgram"
  ]) delete result[key];
  return result;
}
