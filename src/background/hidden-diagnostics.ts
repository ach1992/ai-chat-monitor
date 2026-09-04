import type { HiddenMonitoringDiagnosticSnapshot } from "../core/session-registry.js";
import type { HiddenMonitoringDiagnosticView } from "../shared/protocol.js";

export function toHiddenMonitoringDiagnosticView(
  diagnostic: HiddenMonitoringDiagnosticSnapshot | undefined,
): HiddenMonitoringDiagnosticView | undefined {
  if (diagnostic === undefined) return undefined;
  return {
    backgroundedAt: diagnostic.backgroundedAt,
    ...(diagnostic.foregroundedAt === undefined ? {} : { foregroundedAt: diagnostic.foregroundedAt }),
    ...(diagnostic.baselineAssistantTextLength === undefined ? {} : { baselineAssistantTextLength: diagnostic.baselineAssistantTextLength }),
    hiddenObservationCount: diagnostic.hiddenObservationCount,
    ...(diagnostic.lastHiddenObservationAt === undefined ? {} : { lastHiddenObservationAt: diagnostic.lastHiddenObservationAt }),
    ...(diagnostic.hiddenAssistantTextLength === undefined ? {} : { hiddenAssistantTextLength: diagnostic.hiddenAssistantTextLength }),
    assistantChanged: diagnostic.assistantChanged,
    ...(diagnostic.hiddenGeneration === undefined ? {} : { hiddenGeneration: diagnostic.hiddenGeneration }),
    ...(diagnostic.hiddenStopControlPresent === undefined ? {} : { hiddenStopControlPresent: diagnostic.hiddenStopControlPresent }),
    ...(diagnostic.hiddenMarkerHealth === undefined ? {} : { hiddenMarkerHealth: diagnostic.hiddenMarkerHealth }),
  };
}
