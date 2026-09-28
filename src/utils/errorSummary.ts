/**
 * Collapse an error into a single readable line.
 *
 * Logging an AxiosError directly makes Node's util.inspect walk the whole
 * object graph — config, request, socket, and a [cause] AggregateError — which
 * buries the real message under ~20 lines. A poller that fails every 60s
 * against an absent service then fills the journal with noise that hides
 * genuine errors.
 */
export function errorSummary(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return err;

  const e = err as {
    code?: string;
    message?: string;
    config?: { url?: string };
    url?: string;
    cause?: { code?: string; message?: string };
  };

  const parts: string[] = [];
  const code = e.code || e.cause?.code;
  if (code) parts.push(code);

  const message = e.message || e.cause?.message;
  parts.push(message || String(err));

  const url = e.config?.url || e.url;
  if (url) parts.push(`-> ${url}`);

  return parts.join(" ");
}
