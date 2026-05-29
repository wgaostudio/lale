import { z } from 'zod';

export const ProtocolVersion = z.literal(1);
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

// ---------------------------------------------------------------------------
// Model roles & provider kinds
// ---------------------------------------------------------------------------

export const ModelRole = z.enum(['prover', 'formalizer', 'auxiliary']);
export type ModelRole = z.infer<typeof ModelRole>;

export const ProviderKind = z.enum(['openrouter', 'openaiCompatible', 'local', 'manual']);
export type ProviderKind = z.infer<typeof ProviderKind>;

// ---------------------------------------------------------------------------
// Audit run status & phases
// ---------------------------------------------------------------------------

export const AuditRunStatus = z.enum(['queued', 'running', 'paused', 'cancelled', 'finished']);
export type AuditRunStatus = z.infer<typeof AuditRunStatus>;

export const RunPhase = z.enum([
  'parseSnapshot',
  'buildGraph',
  'selectContext',
  'informalAudit',
  'formalizeStatement',
  'faithfulness',
  'freezeHeader',
  'proverAttempt',
  'finalGate',
  'complete',
]);
export type RunPhase = z.infer<typeof RunPhase>;

// ---------------------------------------------------------------------------
// Verification outcome
// ---------------------------------------------------------------------------

export const VerificationOutcome = z.enum([
  'formalized',
  'verified',
  'malformedClaim',
  'malformedProof',
  'claimContradicted',
  'proofContradicted',
  'proofIncomplete',
  'proofDoesNotSupportClaim',
  'formalizationUnfaithful',
  'dependencyMissing',
  'verificationBlocked',
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

// ---------------------------------------------------------------------------
// Faithfulness verdict
// ---------------------------------------------------------------------------

export const FaithfulnessVerdict = z.enum([
  'faithful',
  'likelyFaithful',
  'unfaithful',
  'needsHumanReview',
]);
export type FaithfulnessVerdict = z.infer<typeof FaithfulnessVerdict>;

// ---------------------------------------------------------------------------
// Informal audit verdict
// ---------------------------------------------------------------------------

export const InformalAuditVerdict = z.enum([
  'noObviousIssue',
  'possibleTypo',
  'possibleGap',
  'possibleContradiction',
  'possibleClaimProofMismatch',
  'uncertain',
]);
export type InformalAuditVerdict = z.infer<typeof InformalAuditVerdict>;

// ---------------------------------------------------------------------------
// Claim status (derived, cached on extension)
// ---------------------------------------------------------------------------

export const ExtensionClaimStatus = z.enum([
  'pending',
  'formalized',
  'verified',
  'verifiedByOverride',
  'stale',
  'blocked',
  'failed',
  'timedOut',
  'checking',
]);
export type ExtensionClaimStatus = z.infer<typeof ExtensionClaimStatus>;

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export const HealthResponse = z.object({
  protocolVersion: ProtocolVersion,
  status: z.enum(['ok', 'degraded', 'unavailable']),
  lean: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    projectReady: z.boolean(),
  }),
  cache: z.object({
    available: z.boolean(),
    entries: z.number().int().nonnegative().nullable(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------------------------------------------------------------------------
// Overleaf document snapshot
// ---------------------------------------------------------------------------

export const OverleafDocumentSnapshot = z.object({
  source: z.literal('overleaf'),
  projectId: z.string().nullable(),
  documentText: z.string(),
  selectedText: z.string().nullable(),
  url: z.string().url().nullable(),
  capturedAt: z.string(),
});
export type OverleafDocumentSnapshot = z.infer<typeof OverleafDocumentSnapshot>;

// ---------------------------------------------------------------------------
// Verification request / response
// ---------------------------------------------------------------------------

export const VerificationRequest = z.object({
  protocolVersion: ProtocolVersion,
  requestId: z.string(),
  projectId: z.string().nullable(),
  claimId: z.string(),
  snapshot: OverleafDocumentSnapshot,
  parsedDocumentFingerprint: z.string(),
  parserVersion: z.string(),
});
export type VerificationRequest = z.infer<typeof VerificationRequest>;

// Immediate 202 response — desktop accepted the run; client polls/streams for results.
export const AcceptedRunResponse = z.object({
  protocolVersion: ProtocolVersion,
  runId: z.string(),
  requestId: z.string(),
  claimId: z.string(),
  status: z.literal('accepted'),
});
export type AcceptedRunResponse = z.infer<typeof AcceptedRunResponse>;

// Final run result (GET /v1/runs/:runId)
export const RunResult = z.object({
  protocolVersion: ProtocolVersion,
  runId: z.string(),
  claimId: z.string(),
  status: AuditRunStatus,
  outcome: VerificationOutcome.nullable(),
  faithfulnessVerdict: FaithfulnessVerdict.nullable(),
  leanSource: z.string().nullable(),
  diagnostics: z.array(z.string()),
  durationMs: z.number().nullable(),
});
export type RunResult = z.infer<typeof RunResult>;

// ---------------------------------------------------------------------------
// SSE run events (GET /v1/runs/:runId/events)
// ---------------------------------------------------------------------------

export const RunEventLevel = z.enum(['info', 'warning', 'error']);
export type RunEventLevel = z.infer<typeof RunEventLevel>;

export const RunEvent = z.object({
  eventId: z.string(),
  auditRunId: z.string(),
  timestamp: z.string(),
  phase: RunPhase,
  level: RunEventLevel,
  message: z.string(),
  payload: z.unknown().optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

// ---------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------

export const OverleafProjectContext = z.object({
  source: z.literal('overleaf'),
  projectId: z.string().nullable(),
  url: z.string().url().nullable(),
  detectedAt: z.string(),
});
export type OverleafProjectContext = z.infer<typeof OverleafProjectContext>;

export const DesktopProject = z.object({
  id: z.string(),
  name: z.string(),
  sourceKind: z.literal('overleaf'),
  overleafProjectId: z.string().nullable(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  leanVersion: z.string(),
  mathlibRevision: z.string(),
});
export type DesktopProject = z.infer<typeof DesktopProject>;

export const DesktopClaimStatus = z.object({
  claimId: z.string(),
  label: z.string().nullable(),
  kind: z.string(),
  status: ExtensionClaimStatus,
  runId: z.string().nullable(),
  phase: RunPhase.nullable(),
  outcome: VerificationOutcome.nullable(),
  message: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type DesktopClaimStatus = z.infer<typeof DesktopClaimStatus>;

export const ProjectLookupRequest = z.object({
  protocolVersion: ProtocolVersion,
  sourceKind: z.literal('overleaf'),
  overleafProjectId: z.string().nullable(),
  overleafUrl: z.string().url().nullable(),
  documentFingerprint: z.string().nullable(),
});
export type ProjectLookupRequest = z.infer<typeof ProjectLookupRequest>;

export const ProjectLookupResponse = z.object({
  protocolVersion: ProtocolVersion,
  status: z.enum(['linked', 'notFound']),
  project: DesktopProject.nullable(),
  claimStatuses: z.array(DesktopClaimStatus).default([]),
});
export type ProjectLookupResponse = z.infer<typeof ProjectLookupResponse>;

export const CreateProjectRequest = z.object({
  protocolVersion: ProtocolVersion,
  sourceKind: z.literal('overleaf'),
  overleafProjectId: z.string().nullable(),
  overleafUrl: z.string().url().nullable(),
  documentFingerprint: z.string(),
  name: z.string(),
  leanVersion: z.string().optional(),
  mathlibRevision: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// ---------------------------------------------------------------------------
// Provider config (managed by desktop, surfaced to extension for display only)
// ---------------------------------------------------------------------------

export const ProviderConfigSummary = z.object({
  providerConfigId: z.string(),
  role: ModelRole,
  providerKind: ProviderKind,
  modelId: z.string(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
});
export type ProviderConfigSummary = z.infer<typeof ProviderConfigSummary>;

// ---------------------------------------------------------------------------
// Lean + Mathlib provisioning (§4 backend spec)
// ---------------------------------------------------------------------------

export const ProvisionStatus = z.enum(['idle', 'running', 'ready', 'failed']);
export type ProvisionStatus = z.infer<typeof ProvisionStatus>;

export const ProvisionStep = z.enum([
  'start',
  'detectElan',
  'installElan',
  'writeProject',
  'installToolchain',
  'lakeUpdate',
  'lakeCacheGet',
  'verify',
  'complete',
  'error',
]);
export type ProvisionStep = z.infer<typeof ProvisionStep>;

export const ProvisionEvent = z.object({
  eventId: z.string(),
  provisionId: z.string(),
  timestamp: z.string(),
  step: ProvisionStep,
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ProvisionEvent = z.infer<typeof ProvisionEvent>;

export const ProvisionRequest = z.object({
  protocolVersion: ProtocolVersion,
  leanVersion: z.string().optional(),
  mathlibRevision: z.string().optional(),
  // If true, reprovision even when the project dir already looks ready.
  force: z.boolean().optional(),
});
export type ProvisionRequest = z.infer<typeof ProvisionRequest>;

export const AcceptedProvisionResponse = z.object({
  protocolVersion: ProtocolVersion,
  provisionId: z.string(),
  status: z.literal('accepted'),
});
export type AcceptedProvisionResponse = z.infer<typeof AcceptedProvisionResponse>;

export const ProvisionStateResponse = z.object({
  protocolVersion: ProtocolVersion,
  provisionId: z.string().nullable(),
  status: ProvisionStatus,
  leanVersion: z.string().nullable(),
  mathlibRevision: z.string().nullable(),
  projectDir: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  projectReady: z.boolean(),
});
export type ProvisionStateResponse = z.infer<typeof ProvisionStateResponse>;

// ---------------------------------------------------------------------------
// Legacy — kept for extension compatibility during migration
// ---------------------------------------------------------------------------

/** @deprecated Use AcceptedRunResponse + SSE. Remove once extension is updated. */
export const VerificationResponse = z.object({
  protocolVersion: ProtocolVersion,
  requestId: z.string(),
  claimId: z.string(),
  status: z.enum(['accepted', 'verified', 'failed']),
  leanCode: z.string().nullable(),
  diagnostics: z.array(z.string()),
  failureCategory: z
    .enum(['parseFailure', 'unknownIdentifier', 'typeMismatch', 'proofFailure', 'timeout'])
    .nullable(),
});
export type VerificationResponse = z.infer<typeof VerificationResponse>;
