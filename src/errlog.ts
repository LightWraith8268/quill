// In-memory ring buffer for recent errors. Caps at 500.
// Patches console.error once at module-load to capture global errors.

export type ErrEvent = {
  ts: number;
  source: string;
  message: string;
  stack?: string;
  meta?: unknown;
};

const CAP = 500;
const buffer: ErrEvent[] = [];

export function logError(source: string, err: unknown, meta?: unknown): void {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : safeStringify(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const ev: ErrEvent = { ts: Date.now(), source, message, stack, meta };
  buffer.push(ev);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

export function recentErrors(limit = 100): ErrEvent[] {
  const n = Math.max(1, Math.min(CAP, Math.floor(limit)));
  // newest first
  return buffer.slice(-n).reverse();
}

export function clearErrors(): void {
  buffer.length = 0;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Patch console.error once. Keep original reference to avoid recursion.
type ConsoleErr = (...args: unknown[]) => void;
type Patchable = { __quillErrlogPatched?: boolean };
const consoleAny = console as unknown as Patchable & { error: ConsoleErr };
if (!consoleAny.__quillErrlogPatched) {
  const original: ConsoleErr = consoleAny.error.bind(console);
  const wrapped: ConsoleErr = (...args: unknown[]): void => {
    try {
      const first = args[0];
      const rest = args.slice(1);
      const message =
        first instanceof Error
          ? first.message
          : args
              .map((a) =>
                a instanceof Error ? a.message : typeof a === "string" ? a : safeStringify(a)
              )
              .join(" ");
      const stack = first instanceof Error ? first.stack : undefined;
      buffer.push({
        ts: Date.now(),
        source: "console",
        message,
        stack,
        meta: rest.length ? rest : undefined,
      });
      if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
    } catch {
      // never fail
    }
    original(...args);
  };
  consoleAny.error = wrapped;
  consoleAny.__quillErrlogPatched = true;
}
