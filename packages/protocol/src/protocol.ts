import { z } from 'zod';

export const ProtocolVersion = z.literal(1);
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

// ---------------------------------------------------------------------------
// Model roles & provider kinds
// ---------------------------------------------------------------------------

export const ModelRole = z.enum(['proposer', 'formalizer', 'auxiliary']);
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
  'proofSteps',
  'proposerAttempt',
  'finalGate',
  'complete',
]);
export type RunPhase = z.infer<typeof RunPhase>;

// ---------------------------------------------------------------------------
// Verification outcome
// ---------------------------------------------------------------------------

// Every member here is produced by the pipeline and documented in
// docs/tester-quickstart.md. `claimContradicted` and `proofContradicted` used to
// sit in this list and were never once written: nothing in the pipeline can
// establish that a claim is false, only that no proposal of it was accepted.
export const VerificationOutcome = z.enum([
  'formalized',
  'verified',
  'malformedClaim',
  'malformedProof',
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
  'checking',
]);
export type ExtensionClaimStatus = z.infer<typeof ExtensionClaimStatus>;

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export const HealthResponse = z.object({
  protocolVersion: ProtocolVersion,
  /** Desktop build, so a report from a tester names the version it came from. */
  version: z.string().default('0.0.0-dev'),
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

/**
 * - `full`: statement formalization, then PROOF GENERATION — the model writes a
 *   whole Lean proof and the kernel adjudicates it. A pass means the theorem is
 *   true; the author's own argument is not audited.
 * - `formalizeOnly`: stop after formalization and the faithfulness checks —
 *   cheap, and enough to surface an ambiguous statement.
 * - `proofSkeleton`: PROOF FORMALIZATION — split the author's proof into the
 *   steps it argues and state each in Lean under the theorem's hypotheses, then
 *   prove them. This audits the argument rather than the conclusion, so a gap
 *   localises to a step.
 */
export const VerificationMode = z.enum(['full', 'formalizeOnly', 'proofSkeleton']);
export type VerificationMode = z.infer<typeof VerificationMode>;

export const VerificationRequest = z.object({
  protocolVersion: ProtocolVersion,
  requestId: z.string(),
  projectId: z.string().nullable(),
  claimId: z.string(),
  snapshot: OverleafDocumentSnapshot,
  parsedDocumentFingerprint: z.string(),
  parserVersion: z.string(),
  mode: VerificationMode.default('full'),
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
  claimFingerprint: z.string().nullable().default(null),
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
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// ---------------------------------------------------------------------------
// Provider config (managed by desktop, surfaced to extension for display only)
// ---------------------------------------------------------------------------

/** What the panel shows for one model role. Every role reports the same shape. */
export const ProviderConfigSummary = z.object({
  providerConfigId: z.string(),
  /** Display name of the provider, e.g. `OpenRouter`. */
  provider: z.string(),
  modelId: z.string(),
  baseUrl: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
});
export type ProviderConfigSummary = z.infer<typeof ProviderConfigSummary>;

// GET /v1/provider-configs. One stored OpenRouter key backs all three roles, so
// key presence is a single flag rather than a field on each summary.
export const ProviderConfigsResponse = z.object({
  formalizerConfig: ProviderConfigSummary.nullable(),
  proposerConfig: ProviderConfigSummary.nullable(),
  auxiliaryConfig: ProviderConfigSummary.nullable(),
  hasKey: z.boolean(),
});
export type ProviderConfigsResponse = z.infer<typeof ProviderConfigsResponse>;

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
