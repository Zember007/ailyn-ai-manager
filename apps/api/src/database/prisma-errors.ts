import { Prisma } from "@prisma/client";

export const DATABASE_SCHEMA_MISSING_CODE = "database_schema_missing";

export function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

export function isSchemaMissingError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes(DATABASE_SCHEMA_MISSING_CODE)) {
    return true;
  }

  return isPrismaKnownError(error) && (error.code === "P2021" || error.code === "P2022");
}

export function toPublicDatabaseErrorMessage(error: unknown): string | undefined {
  if (!isSchemaMissingError(error)) {
    return undefined;
  }

  const missingTable = isPrismaKnownError(error) ? extractMissingTable(error.meta?.table as string | undefined) : undefined;
  return missingTable
    ? `${DATABASE_SCHEMA_MISSING_CODE}:${missingTable}`
    : DATABASE_SCHEMA_MISSING_CODE;
}

function extractMissingTable(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^public\./, "");
}
