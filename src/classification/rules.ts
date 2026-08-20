import { boundedReason, type ClassificationResult, type SanitizedContext } from "./types.js";

interface HoldRule {
  code: ClassificationResult["reasonCode"];
  reason: string;
  pattern: RegExp;
}

const ASSISTANT_HOLD_RULES: readonly HoldRule[] = [
  {
    code: "HUMAN_APPROVAL_REQUIRED",
    reason: "The assistant explicitly requires human approval before continuing.",
    pattern: /\bAPPROVAL_REQUIRED\b|\b(?:need|requires?|awaiting) (?:your |human )?approval before (?:I |we )?(?:can )?(?:continue|proceed)\b/i,
  },
  {
    code: "MATERIAL_DECISION_REQUIRED",
    reason: "The assistant explicitly requires a material human decision.",
    pattern: /\bMATERIAL_DECISION_REQUIRED\b|\b(?:need|requires?|awaiting) (?:your |a human )?(?:decision|choice) before (?:I |we )?(?:can )?(?:continue|proceed)\b/i,
  },
  {
    code: "HUMAN_OPERATION_REQUIRED",
    reason: "The assistant explicitly requires a human-only operation.",
    pattern: /\bHUMAN_OPERATION_REQUIRED\b|\byou (?:must|need to) (?:manually )?(?:complete|perform|approve|confirm|sign in|authenticate)\b|\b(?:please\s+)?(?:copy|paste|send|relay|take|run|execute)\b[\s\S]{0,220}\b(?:another|new|separate|independent|external)(?:\s+(?:new|separate|independent|external|review)){0,2}\s+(?:chat|conversation|person|reviewer|tool)\b|\b(?:another|new|separate|independent|external)(?:\s+(?:new|separate|independent|external|review)){0,2}\s+(?:chat|conversation|person|reviewer|tool)\b[\s\S]{0,220}\b(?:copy|paste|send|relay|take|run|execute)\b/i,
  },
  {
    code: "PROJECT_COMPLETE",
    reason: "The assistant explicitly reports completion rather than a needless turn boundary.",
    pattern: /\bPROJECT_COMPLETE\b|\b(?:the )?(?:task|project|requested work) is (?:now )?(?:complete|completed|finished)\b/i,
  },
  {
    code: "RATE_LIMIT",
    reason: "The assistant reports a provider or platform rate/usage limit.",
    pattern: /\bRATE_LIMIT\b|\brate limit(?:ed)?\b|\btoo many requests\b|\busage limit\b/i,
  },
  {
    code: "PLATFORM_ERROR",
    reason: "The assistant reports a platform or network error that requires a hold.",
    pattern: /\bPLATFORM_ERROR\b|\bnetwork error\b|\bsession expired\b|\bsomething went wrong\b/i,
  },
  {
    code: "SAFETY_BOUNDARY",
    reason: "The assistant explicitly identifies a safety or policy boundary.",
    pattern: /\bSAFETY_BOUNDARY\b|\b(?:cannot|can't) proceed (?:safely|without (?:authorization|verification|confirmation))\b/i,
  },
];

const USER_STOP_PATTERN = /^(?:stop|pause|hold|do not continue|don't continue|wait|cancel|متوقف شو|صبر کن|ادامه نده)[.!\s]*$/iu;

const USER_PREAUTHORIZED_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /\bwithout asking (?:me )?(?:any )?[\s\S]{0,180}\b(?:approval|confirmation|choice|decision|credential|new information|human input)\b/i,
  /\b(?:do not|don't) (?:ask|wait) (?:me )?(?:for )?[\s\S]{0,160}\b(?:approval|confirmation|choice|decision|credential|new information|human input)\b/i,
  /\b(?:continue|proceed|complete)[\s\S]{0,120}\bwithout (?:further )?(?:human input|approval|confirmation)\b/i,
];

const GENERIC_CONTINUATION_REQUEST_PATTERN = /\b(?:say|reply(?:\s+with)?|respond(?:\s+with)?|type|send)\s+["'`]*(?:continue|go ahead|proceed)["'`]*\b/i;
const GENERIC_CONTINUATION_DISQUALIFIER_PATTERN = /\b(?:when|once|after)\b|\b(?:provide|upload|attach|share|choose|select|approve|confirm|authenticate|sign in|log in)\b/i;

function isExplicitPreauthorizedContinuationBoundary(
  latestUser: SanitizedContext["turns"][number] | undefined,
  latestAssistant: SanitizedContext["turns"][number],
): boolean {
  if (latestUser === undefined) return false;
  if (!USER_PREAUTHORIZED_CONTINUATION_PATTERNS.some((pattern) => pattern.test(latestUser.content))) {
    return false;
  }

  const terminalTail = latestAssistant.content.trim().slice(-240);
  if (!GENERIC_CONTINUATION_REQUEST_PATTERN.test(terminalTail)) return false;
  if (GENERIC_CONTINUATION_DISQUALIFIER_PATTERN.test(terminalTail)) return false;
  return true;
}

export function evaluateDeterministicRules(context: SanitizedContext): ClassificationResult | undefined {
  const latestAssistant = [...context.turns].reverse().find((turn) => turn.role === "assistant");
  const latestUser = [...context.turns].reverse().find((turn) => turn.role === "user");

  if (latestUser !== undefined && USER_STOP_PATTERN.test(latestUser.content.trim())) {
    return {
      decision: "HOLD",
      reasonCode: "USER_STOP",
      reason: "The latest user turn explicitly asks the workflow to stop or wait.",
      source: "RULE",
      confidence: 1,
    };
  }

  if (latestAssistant === undefined) return undefined;
  for (const rule of ASSISTANT_HOLD_RULES) {
    if (!rule.pattern.test(latestAssistant.content)) continue;
    return {
      decision: "HOLD",
      reasonCode: rule.code,
      reason: boundedReason(rule.reason),
      source: "RULE",
      confidence: 1,
    };
  }

  if (isExplicitPreauthorizedContinuationBoundary(latestUser, latestAssistant)) {
    return {
      decision: "CONTINUE",
      reasonCode: "NEEDLESS_TURN_BOUNDARY",
      reason: "The assistant is waiting only for a generic continuation token that the user already pre-authorized.",
      source: "RULE",
      confidence: 1,
    };
  }

  return undefined;
}
