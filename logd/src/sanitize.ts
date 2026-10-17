export function sanitizeLogMessage(message: string) {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/([?&](?:token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 65_536);
}
