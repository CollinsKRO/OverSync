import pino, { type Logger } from "pino";
import { redactSensitive } from "./redaction.js";

let cached: Logger | null = null;

export function createLogger(level: string = "info", destination: { write(chunk: string): void } = process.stdout): Logger {
  return pino({ level, base: { service: "oversync-coordinator" } }, {
    write(chunk: string) {
      destination.write(redactSensitive(chunk));
    }
  });
}

export function getLogger(level: string = "info"): Logger {
  if (!cached) {
    cached = createLogger(level);
  }
  return cached;
}
