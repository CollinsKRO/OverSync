import { z } from "zod";

export interface CursorData {
  offset: number;
  createdAt: number;
}

export type Cursor = z.infer<typeof cursorSchema>;

export const cursorSchema = z.object({
  cursor: z.string().refine((value) => decodeCursor(value) !== null, {
    message: "Cursor must be a base64-encoded cursor",
  }),
});

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("offset" in parsed) ||
      !("createdAt" in parsed) ||
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      typeof parsed.createdAt !== "number" ||
      !Number.isFinite(parsed.createdAt)
    ) {
      return null;
    }

    return {
      offset: parsed.offset,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function validateCursor(cursor: { offset: number; createdAt: number }): boolean {
  if (typeof cursor.offset !== "number" || typeof cursor.createdAt !== "number") return false;
  if (isNaN(cursor.offset) || isNaN(cursor.createdAt)) return false;
  if (cursor.offset < 0) return false;
  return true;
}