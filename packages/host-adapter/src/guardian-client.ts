/**
 * guardianClient.post (N4) is the adapter's one wire primitive: POST a
 * JSON-RPC 2.0 envelope to the Guardian's ACS endpoint and return the
 * parsed JSON-RPC response.
 *
 * Correlation note (Task 7 -> Task 8): buildEnvelope sets the envelope's
 * top-level `id` equal to `params.request_id` (a fresh uuid per call).
 * That is sufficient here: `id` is schema-legal as a string (per
 * request-envelope.json, `id` is `oneOf` string/number, with no format
 * constraint of its own), and since `fetch` already pairs this exact HTTP
 * request with this exact HTTP response one-to-one, there is no
 * multiplexing problem to solve. The id check below is a defensive
 * assertion -- it catches a Guardian bug that echoes back the wrong id --
 * not a lookup table matching concurrent in-flight requests. Nothing about
 * Task 7's choice needs to change.
 *
 * R3.2: this module knows JSON-RPC and HTTP, nothing else. It has no
 * runtime dependency on the Guardian or policy-bridge packages -- it talks
 * to the Guardian only over the wire, at whatever `url` the caller gives.
 */

/** The minimal JSON-RPC 2.0 request shape this client sends. Loose on
 * `params` on purpose: buildEnvelope's ACS request params and handshake's
 * ClientHello params are different shapes, and this module doesn't need
 * to know either -- it moves whatever `params` object it's given. */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  id: string | number;
  params: Record<string, unknown>;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: Record<string, unknown>;
  error?: undefined;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: undefined;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Thrown when the Guardian's response id doesn't match the request's --
 * i.e. the response cannot be trusted to belong to this request. */
export class GuardianResponseMismatchError extends Error {
  constructor(requestId: string | number, responseId: string | number | null) {
    super(
      `guardianClient.post: response id ${JSON.stringify(responseId)} does not correlate with request id ${JSON.stringify(requestId)}`,
    );
    this.name = "GuardianResponseMismatchError";
  }
}

export const guardianClient = {
  /** POSTs `envelope` to `url` as JSON, parses the JSON-RPC response, and
   * returns it once its `id` is confirmed to match the request's `id`. */
  async post(url: string, envelope: JsonRpcRequest): Promise<JsonRpcResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });

    const response = (await res.json()) as JsonRpcResponse;

    if (response.id !== envelope.id) {
      throw new GuardianResponseMismatchError(envelope.id, response.id);
    }

    return response;
  },
};
