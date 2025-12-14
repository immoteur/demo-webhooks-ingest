export const WEBHOOK_EVENT_TYPES = ['classified-notification', 'classifieds-export'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function safeJsonParse(
  rawBody: string,
): { success: true; data: unknown } | { success: false; error: string } {
  try {
    if (rawBody.trim() === '') return { success: false, error: 'empty body' };
    return { success: true, data: JSON.parse(rawBody) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function extractStringId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function extractNotificationType(record: Record<string, unknown>): string | null {
  return extractStringId(record.type);
}
