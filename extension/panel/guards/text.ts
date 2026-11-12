/** User-facing text for service failures. Shared by the panel and the status section. */
import type { ServiceFailure } from "./service.ts"

const HOST_FAILURES: Record<string, string> = {
  NOT_GRANTED: "The local service is not approved. Approve it in Settings → Extensions.",
  NO_SERVICE: "The local service is not running or not approved. Check Settings → Extensions.",
  DISABLED: "The extension is paused. Turn it on again in Settings → Extensions.",
  SERVICE_FAILED: "The local service stopped or did not start.",
}

export const failureText = (failure: ServiceFailure): string => {
  if (failure.kind === "host") return HOST_FAILURES[failure.code] ?? `OpenChamber refused the request (${failure.code}).`
  if (failure.kind === "unclear") return "The service did not give a clear answer."
  return failure.message || `The service refused the request (${failure.code}).`
}
