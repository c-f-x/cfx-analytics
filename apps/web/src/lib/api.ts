// The dashboard's one way to the Worker's API: same origin, so the session
// cookie goes with every call, and JSON both ways. A failed answer throws an
// HttpError carrying its status and the API's one-sentence message, so a
// screen can show what went wrong and a 401 can send the owner to sign in.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function failure(response: Response): Promise<HttpError> {
  let code: string | null = null;
  let message = `The server answered ${String(response.status)}.`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      if ("code" in body && typeof body.code === "string") code = body.code;
      if ("message" in body && typeof body.message === "string") message = body.message;
    }
  } catch {
    // Not JSON: the status sentence stands.
  }
  return new HttpError(response.status, code, message);
}

/** The answer to `path` when it succeeded, or a thrown HttpError. */
async function send(path: string, init: { method?: string; body?: unknown }): Promise<Response> {
  const request: RequestInit = {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {},
  };
  if (init.body !== undefined) {
    request.headers = { "content-type": "application/json" };
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, request);
  if (!response.ok) throw await failure(response);
  return response;
}

/**
 * A JSON answer from `path`, or a thrown HttpError. `T` is the answer's type
 * in @cfanalytics/shared, the same type the Worker answers with.
 */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await send(path, init);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place the dashboard takes the Worker's answer as its shared type
  return (await response.json()) as T;
}

/** A request whose answer has no body to read, such as a 204; a failure throws an HttpError. */
export async function apiDone(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<void> {
  await send(path, init);
}

/** The raw text of `path`, such as a recording's NDJSON, or a thrown HttpError. */
export async function apiText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw await failure(response);
  return response.text();
}

/** Whether an error means the session is missing or expired. */
export const isSignedOut = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 401;
