/**
 * model.ts — Project Memory core data model.
 *
 * Type-level contract for the Note object (YAML frontmatter of a Markdown note
 * file). Mirrors ../schemas/note.schema.json. Deterministic core: no AI/model
 * dependency anywhere in this layer.
 *
 * Design references: Project_Memory_Design.md §5 (memory layering), §8 (Note
 * data model), §8.5 (type-specific statuses), §8.6 (relations), §11.6
 * (Trigger data model).
 */

export const SCHEMA_VERSION = 1

export const NOTE_TYPES = [
  'deferred_work',
  'decision',
  'open_question',
  'assumption',
  'risk',
  'idea',
] as const
export type NoteType = (typeof NOTE_TYPES)[number]

/** ID type abbreviations, e.g. PM-DEF-0001 (§8.2). */
export const TYPE_ABBR: Record<NoteType, string> = {
  deferred_work: 'DEF',
  decision: 'DEC',
  open_question: 'QUE',
  assumption: 'ASM',
  risk: 'RSK',
  idea: 'IDE',
}

export const ABBR_TYPE: Record<string, NoteType> = Object.fromEntries(
  (Object.entries(TYPE_ABBR) as [NoteType, string][]).map(([t, a]) => [a, t]),
) as Record<string, NoteType>

/** Stable ID format: PM-<TYPE>-<SEQUENCE> (§8.2). */
export const NOTE_ID_RE = /^PM-(DEF|DEC|QUE|ASM|RSK|IDE)-(\d{4,})$/

/**
 * Per-type legal status sets (the state machine). Statuses are constrained per
 * type and never free-form strings (§8.5). `promoted` is added uniformly to
 * every type: promote() always lands the note in status `promoted` (§12.3).
 */
export const STATUSES: Record<NoteType, readonly string[]> = {
  deferred_work: ['deferred', 'ready', 'in_progress', 'done', 'dropped', 'promoted'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded', 'promoted'],
  open_question: ['open', 'answered', 'closed', 'promoted'],
  assumption: ['unvalidated', 'supported', 'invalidated', 'expired', 'promoted'],
  risk: ['open', 'mitigated', 'accepted', 'realized', 'closed', 'promoted'],
  idea: ['captured', 'incubating', 'rejected', 'promoted', 'archived'],
}

/** Status a fresh note of each type starts in. */
export const DEFAULT_STATUS: Record<NoteType, string> = {
  deferred_work: 'deferred',
  decision: 'proposed',
  open_question: 'open',
  assumption: 'unvalidated',
  risk: 'open',
  idea: 'captured',
}

/**
 * Terminal statuses: default retrieval must not return notes in these states
 * (§11.1, invariant 10). Added to memory semantics: terminal means "no longer
 * an active candidate for reactivation" for search/trigger purposes.
 */
export const TERMINAL_STATUSES: Record<NoteType, readonly string[]> = {
  deferred_work: ['done', 'dropped', 'promoted'],
  decision: ['rejected', 'superseded', 'promoted'],
  open_question: ['closed', 'promoted'],
  assumption: ['invalidated', 'expired', 'promoted'],
  risk: ['closed', 'promoted'],
  idea: ['rejected', 'promoted', 'archived'],
}

export function statusesFor(type: NoteType): readonly string[] {
  return STATUSES[type]
}

export function defaultStatusFor(type: NoteType): string {
  return DEFAULT_STATUS[type]
}

export function isTerminal(type: NoteType, status: string): boolean {
  return TERMINAL_STATUSES[type].includes(status)
}

export function isTerminalNote(note: Pick<Note, 'type' | 'status'>): boolean {
  return isTerminal(note.type, note.status)
}

/** §8.5: legal status = member of the type's status set. */
export function isLegalStatus(type: NoteType, status: string): boolean {
  return STATUSES[type].includes(status)
}

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']

/** §4.6 / §7.2: explicit authority on every object. */
export type Authority = 'memory' | 'canonical' | 'source'

export const AUTHORITIES: readonly Authority[] = ['memory', 'canonical', 'source']

/**
 * Notes stored in .project-memory ALWAYS carry authority 'memory' (§7.2):
 * canonical/source truth lives only in the canonical sources themselves.
 * Writing any other value into a note would create a second source of truth.
 */
export type NoteAuthority = 'memory'

export const NOTE_AUTHORITIES: readonly NoteAuthority[] = ['memory']

export type Confidence = 'explicit_discussion' | 'inferred' | 'unverified'

export const CONFIDENCES: readonly Confidence[] = ['explicit_discussion', 'inferred', 'unverified']

export type Sensitivity = 'internal' | 'public' | 'restricted'

export const SENSITIVITIES: readonly Sensitivity[] = ['internal', 'public', 'restricted']

/** Cross-cutting review state; kept separate from each note type's lifecycle status. */
export type ReviewStatus = 'clear' | 'needs_review'

export const REVIEW_STATUSES: readonly ReviewStatus[] = ['clear', 'needs_review']

export type SourceRefKind =
  | 'conversation'
  | 'event'
  | 'file'
  | 'commit'
  | 'issue'
  | 'manual'
  | 'other'

export const SOURCE_REF_KINDS: readonly SourceRefKind[] = [
  'conversation',
  'event',
  'file',
  'commit',
  'issue',
  'manual',
  'other',
]

/** §8.7: provenance-bearing source reference. */
export interface SourceRef {
  kind: SourceRefKind
  /** Stable URI / object id (e.g. chatgpt-conversation://abc, git://…commit). */
  ref: string
  /** Conversation turn / document paragraph / event id when known. */
  turn_id?: string
  /** When the source content was observed. */
  observed_at?: string
  /** Bound excerpt hash (sha256) when a stable excerpt is captured. */
  excerpt_sha256?: string
}

export interface RelatedFile {
  path: string
  relation: string
}

/** §8.6: relation model. Targets prefer stable object IDs. */
export interface Relations {
  depends_on: string[]
  related_to: string[]
  supersedes: string[]
  superseded_by: string[]
  derived_from: string[]
  promoted_to: string[]
}

export function emptyRelations(): Relations {
  return {
    depends_on: [],
    related_to: [],
    supersedes: [],
    superseded_by: [],
    derived_from: [],
    promoted_to: [],
  }
}

/* ------------------------------------------------------------------ */
/* Trigger (§11.6–§11.8)                                               */
/* ------------------------------------------------------------------ */

export type TriggerMode = 'all' | 'any'

export interface MilestoneCondition {
  kind: 'milestone'
  /** Canonical milestone key. */
  key: string
  operator?: 'equals' | 'not_equals' | 'in'
  /** 'in' takes string[]; others take a string. */
  value: string | string[]
}

export interface DependencyCondition {
  kind: 'dependency'
  /** Note id (or stable object id) whose status change gates reactivation. */
  key: string
  operator?: 'status_in' | 'status_equals'
  value: string | string[]
}

export type TriggerCondition = MilestoneCondition | DependencyCondition

export interface Trigger {
  /** Defaults to 'all' when omitted (fail closed: every condition must hold). */
  mode?: TriggerMode
  conditions: TriggerCondition[]
}

/* ------------------------------------------------------------------ */
/* Promotion (§12)                                                     */
/* ------------------------------------------------------------------ */

/** §12.2 canonical target kinds (informational; free-form). */
export type CanonicalTargetKind =
  | 'adr'
  | 'spec'
  | 'architecture'
  | 'protocol'
  | 'issue'
  | 'backlog'
  | 'experiment_spec'
  | 'decision_log'
  | 'evidence'
  | 'file'
  | 'other'

/**
 * A canonical target. `path` is required and must resolve to an existing file
 * inside the project (path stored project-relative). `objectId`/`version` are
 * optional stable references on the canonical side.
 */
export interface CanonicalTarget {
  kind: CanonicalTargetKind
  ref: string
  /** Existing canonical file, project-relative (e.g. docs/adr/0001-fs.md). */
  path: string
  objectId?: string
  version?: string
}

export type PromotionStatus = 'not_promoted' | 'promoting' | 'promoted'

export type BacklinkMode = 'in_file' | 'link_file'

export interface PromotionInfo {
  status: PromotionStatus
  target: CanonicalTarget | null
  promotion_id: string | null
  promoted_at: string | null
  /** 'in_file' = marker embedded in canonical file; 'link_file' = .project-memory/backlinks/. */
  backlink: BacklinkMode | null
  backlink_verified: boolean
}

export function defaultPromotionInfo(): PromotionInfo {
  return {
    status: 'not_promoted',
    target: null,
    promotion_id: null,
    promoted_at: null,
    backlink: null,
    backlink_verified: false,
  }
}

/* ------------------------------------------------------------------ */
/* Note (§8.3)                                                         */
/* ------------------------------------------------------------------ */

/**
 * The full frontmatter of a Note. All fields are validated deterministically
 * by validateNote() in service.ts before any write.
 */
export interface Note {
  schema_version: number
  id: string
  project_id: string
  type: NoteType
  status: string
  /** Exact dedup key: sha256 of normalized (type, title, summary). */
  fingerprint: string
  title: string
  summary: string
  rationale: string
  priority?: Priority
  authority: NoteAuthority
  confidence?: Confidence
  sensitivity?: Sensitivity
  /** Review is orthogonal to the type-specific lifecycle status. */
  review_status: ReviewStatus
  review_reason: string | null
  tags: string[]
  source_refs: SourceRef[]
  related_files: RelatedFile[]
  relations: Relations
  trigger: Trigger | null
  /** Reason a note intentionally has no trigger (§15.5 invariant 5). */
  no_trigger_reason: string | null
  next_action: string
  status_reason: string | null
  /** Required when a decision is captured/updated to status `accepted`. */
  acceptance_evidence: string | null
  created_by: { kind: 'agent' | 'human' | 'tool'; id: string }
  created_at: string
  updated_at: string
  promotion: PromotionInfo
}

/** A parsed note file: frontmatter + body + file location. */
export interface ScannedNote {
  note: Note
  file: string
  /** Body of the Markdown file (after the frontmatter). */
  body: string
  /** sha256 of the full file content (used for index drift detection). */
  sha256: string
}

/* ------------------------------------------------------------------ */
/* Trigger evaluation (§11.6–§11.8)                                    */
/* ------------------------------------------------------------------ */

/**
 * The trusted inputs for lazy trigger evaluation. Milestone values must come
 * from canonical state (never from the notes themselves — §11.7). Dependency
 * statuses default to the actual note statuses in the store; callers may
 * override with a snapshot for test/replay purposes.
 */
export interface CanonicalConflictEvidence {
  /** Stable canonical object/path that conflicts with the historical note. */
  canonical_ref: string
  /** Human- or adapter-supplied explanation; never inferred from the note itself. */
  reason: string
  observed_at?: string
  /** Optional hash of the note revision inspected by the trusted adapter. */
  note_sha256?: string
}

export interface TriggerState {
  milestones: Record<string, string>
  noteStatuses?: Record<string, string>
  /** Trusted canonical-state adapter output, keyed by stable Note ID. */
  canonical_conflicts?: Record<string, CanonicalConflictEvidence>
}

export type ConditionTruth = 'satisfied' | 'unsatisfied' | 'unknown'

export interface ConditionEval {
  index: number
  label: string
  truth: ConditionTruth
}

export type TriggerResultState = 'due' | 'not_due' | 'unresolved'

export interface TriggerResult {
  id: string
  type: NoteType
  status: string
  title: string
  summary: string
  next_action: string
  trigger: Trigger
  state: TriggerResultState
  /** Present when state is 'unresolved': what could not be decided (§11.8). */
  reason?: string
  conditions: ConditionEval[]
}

export interface TriggerEvaluation {
  /**
   * true when canonical state was unavailable and triggers were NOT evaluated
   * (lazy triggers never guess — §11.8). Set only in that case.
   */
  unevaluated?: boolean
  due: TriggerResult[]
  unresolved: TriggerResult[]
  not_due: TriggerResult[]
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_INPUT'
  | 'POLICY_VIOLATION'
  | 'CONFLICT'
  | 'MISSING_CONFIG'
  | 'INCONSISTENT'
  | 'INTERNAL'

/** Typed error for the whole core. `details` carries structured info. */
export class ProjectMemoryError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ProjectMemoryError'
    this.code = code
    this.details = details
  }
}

export function asErrorCode(e: unknown): ErrorCode {
  if (e instanceof ProjectMemoryError) return e.code
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code
    if (c === 'EEXIST') return 'ALREADY_EXISTS'
    if (c === 'ENOENT') return 'NOT_FOUND'
  }
  return 'INTERNAL'
}