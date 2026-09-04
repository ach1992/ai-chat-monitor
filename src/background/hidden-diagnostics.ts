import type { HiddenMonitoringDiagnosticSnapshot } from "../core/session-registry.js";
import type { HiddenMonitoringDiagnosticView } from "../shared/protocol.js";

export function toHiddenMonitoringDiagnosticView(
  diagnostic: HiddenMonitoringDiagnosticSnapshot | undefined,
): HiddenMonitoringDiagnosticView | undefined {
  if (diagnostic === undefined) return undefined;
  return {
    backgroundedAt: diagnostic.backgroundedAt,
    ...(diagnostic.foregroundedAt === undefined ? {} : { foregroundedAt: diagnostic.foregroundedAt }),
    ...(diagnostic.tabActivatedAt === undefined ? {} : { tabActivatedAt: diagnostic.tabActivatedAt }),
    ...(diagnostic.visibleObservedAt === undefined ? {} : { visibleObservedAt: diagnostic.visibleObservedAt }),
    ...(diagnostic.baselineAssistantTextLength === undefined ? {} : { baselineAssistantTextLength: diagnostic.baselineAssistantTextLength }),
    hiddenObservationCount: diagnostic.hiddenObservationCount,
    ...(diagnostic.firstHiddenObservationAt === undefined ? {} : { firstHiddenObservationAt: diagnostic.firstHiddenObservationAt }),
    ...(diagnostic.lastHiddenObservationAt === undefined ? {} : { lastHiddenObservationAt: diagnostic.lastHiddenObservationAt }),
    ...(diagnostic.firstAssistantChangeAt === undefined ? {} : { firstAssistantChangeAt: diagnostic.firstAssistantChangeAt }),
    ...(diagnostic.firstMarkerDetectedAt === undefined ? {} : { firstMarkerDetectedAt: diagnostic.firstMarkerDetectedAt }),
    ...(diagnostic.hiddenAssistantTextLength === undefined ? {} : { hiddenAssistantTextLength: diagnostic.hiddenAssistantTextLength }),
    assistantChanged: diagnostic.assistantChanged,
    ...(diagnostic.hiddenGeneration === undefined ? {} : { hiddenGeneration: diagnostic.hiddenGeneration }),
    ...(diagnostic.hiddenStopControlPresent === undefined ? {} : { hiddenStopControlPresent: diagnostic.hiddenStopControlPresent }),
    ...(diagnostic.hiddenMarkerHealth === undefined ? {} : { hiddenMarkerHealth: diagnostic.hiddenMarkerHealth }),
    ...(diagnostic.transportCompletedAt === undefined ? {} : { transportCompletedAt: diagnostic.transportCompletedAt }),
  };
}
