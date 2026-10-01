import type { Request, RequestHandler, Response } from "express";

const SENSITIVE_FIELD =
  /^(?:preimage|authorization|private[_-]?key|wallet[_-]?secret|bearer[_-]?token)$/i;
const SENSITIVE_ENV =
  /(?:PRIVATE_KEY|WALLET_SECRET|BEARER_TOKEN|SERVICE_TOKEN|PASSWORD|API_KEY|PREIMAGE|DATABASE_URL|RPC_URL)$/i;

function collectSensitiveValues(req: Request): string[] {
  const values = Object.entries(process.env)
    .filter(([name]) => SENSITIVE_ENV.test(name))
    .map(([, value]) => value)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length >= 4,
    );

  const preimage = req.body?.preimage;
  if (typeof preimage === "string" && preimage.length >= 4)
    values.push(preimage);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function redactText(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const secret of sensitiveValues)
    redacted = redacted.split(secret).join("[REDACTED]");

  return redacted
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(
      /\bAuthorization\s*[:=]\s*[^\s,;"']+/gi,
      "Authorization: [REDACTED]",
    )
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl.replace(/[),.;]+$/, ""));
        return url.username || url.password ? url.origin : rawUrl;
      } catch {
        return rawUrl;
      }
    });
}

function redactValue(
  value: unknown,
  sensitiveValues: string[],
  allowPreimage = false,
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      redactValue(item, sensitiveValues, allowPreimage),
    );
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            (allowPreimage && key.toLowerCase() === "preimage") ||
            !SENSITIVE_FIELD.test(key),
        )
        .map(([key, item]) => [
          key,
          allowPreimage && key.toLowerCase() === "preimage"
            ? item
            : redactValue(item, sensitiveValues, allowPreimage),
        ]),
    );
  }
  return typeof value === "string" ? redactText(value, sensitiveValues) : value;
}

function redactTextResponse(
  chunk: unknown,
  response: Response,
  sensitiveValues: string[],
): unknown {
  const contentType = response.get("Content-Type") ?? "";
  if (typeof chunk === "string") return redactText(chunk, sensitiveValues);
  if (
    !/^text\//i.test(contentType) &&
    !/application\/(?:json|[^;]+\+json)/i.test(contentType)
  ) {
    return chunk;
  }
  if (Buffer.isBuffer(chunk))
    return Buffer.from(redactText(chunk.toString("utf8"), sensitiveValues));
  return chunk;
}

export const publicResponseRedaction: RequestHandler = (req, res, next) => {
  const sensitiveValues = collectSensitiveValues(req);
  const isSuccessfulSecretLookup = () =>
    req.method === "GET" &&
    /^\/api\/secrets\/[^/?]+(?:\?.*)?$/.test(req.originalUrl) &&
    res.statusCode < 400;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  res.json = ((body: unknown) =>
    originalJson(
      redactValue(body, sensitiveValues, isSuccessfulSecretLookup()),
    )) as typeof res.json;
  res.send = ((body?: unknown) => {
    if (
      isSuccessfulSecretLookup() &&
      typeof body === "string" &&
      /application\/json/i.test(res.get("Content-Type") ?? "")
    ) {
      try {
        const parsed = JSON.parse(body) as unknown;
        return originalSend(
          JSON.stringify(redactValue(parsed, sensitiveValues, true)),
        );
      } catch {
        // Non-JSON text still goes through the regular text sanitizer below.
      }
    }
    const safeBody =
      typeof body === "string" || Buffer.isBuffer(body)
        ? redactTextResponse(body, res, sensitiveValues)
        : redactValue(body, sensitiveValues);
    return originalSend(safeBody as never);
  }) as typeof res.send;
  res.end = ((
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    const safeChunk = redactTextResponse(chunk, res, sensitiveValues);
    return originalEnd(
      safeChunk as never,
      encodingOrCallback as never,
      callback,
    );
  }) as typeof res.end;

  next();
};
