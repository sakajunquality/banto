// One-line JSON logs, the shape Cloud Logging picks up without a sidecar.
// `severity` and `message` are the fields the agent promotes; everything else
// is kept as structured payload.

export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<Severity, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

export function createLogger(
  level: Severity = "INFO",
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  const threshold = ORDER[level];
  const emit = (severity: Severity, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[severity] < threshold) return;
    // Never spread unknown objects in here: callers are expected to pass
    // scalars they have already vetted. Secrets must not reach this function.
    sink(JSON.stringify({ severity, message, ...fields }));
  };
  return {
    debug: (m, f) => emit("DEBUG", m, f),
    info: (m, f) => emit("INFO", m, f),
    warn: (m, f) => emit("WARNING", m, f),
    error: (m, f) => emit("ERROR", m, f),
  };
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
