/**
 * service.ts — deterministic Project Memory service layer.
 *
 * The model (via a Skill) decides WHAT is semantically valuable; this layer
 * decides HOW it is stored, validated, deduplicated, retrieved, promoted and
 * reconciled. No AI/model dependency: every guarantee here is enforced by
 * code, not by prompt instructions (§3.2, §3.5, §10.4).
 *
 * Implemented behavior:
 *   - capture / read / search / update / close (model-facing ops, §15.2)
 *   - exact-fingerprint dedup with source merging (§10.6)
 *   - recursive secret scanning with fail-closed rejection (§9.7, §4.11)
 *   - lazy milestone/dependency trigger evaluation (§11.6–§11.8)
 *   - content-bound promote: planPromotion → UI approval record → CAS
 *     triple-locked promote; promotion_id idempotency, write-then-readback,
 *     bidirectional links (§12)
 *   - durable pending-capture envelopes with atomic candidate resolution
 *   - reconcile: schema/duplicate/cycle/promotion-target/index-drift checks,
 *     index auto-repair only (§13)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as yaml from 'yaml'

import {
  SCHEMA_VERSION,
  NOTE_TYPES,
  TYPE_ABBR,
  NOTE_ID_RE,
  STATUSES,
  DEFAULT_STATUS,
  isLegalStatus,
  isTerminal,
  isTerminalNote,
  PRIORITIES,
  CONFIDENCES,
  SENSITIVITIES,
  REVIEW_STATUSES,
  SOURCE_REF_KINDS,
  emptyRelations,
  defaultPromotionInfo,
  ProjectMemoryError,
} from './model.ts'
import type {
  NoteType,
  Priority,
  Authority,
  NoteAuthority,
  Confidence,
  Sensitivity,
  ReviewStatus,
  SourceRef,
  RelatedFile,
  Relations,
  Trigger,
  TriggerCondition,
  TriggerState,
  CanonicalConflictEvidence,
  ConditionEval,
  TriggerResult,
  TriggerEvaluation,
  CanonicalTarget,
  CanonicalTargetKind,
  BacklinkMode,
  Note,
  ScannedNote,
} from './model.ts'
import {
  assertProjectDir,
  assertProjectRelativePath,
  rejectSymlinkComponents,
  readConfig,
  initProjectStorage,
  scanNotes,
  createNoteFileExclusive,
  writeNoteFile,
  writeNoteFileCas,
  writeFileAtomic,
  writeFileAtomicBatch,
  tryReadText,
  relPath,
  sha256hex,
  fingerprintOf,
  IN_FILE_MARKER_RE,
  inFileMarker,
  inFileMarkerLine,
  linkFileFor,
  readBacklinks,
  writeIndexAtomic,
  readIndex,
  indexNoteEntries,
  parseBacklinkFileThatExists,
  TYPE_DIR,
  locksDir,
  approvalsDir,
  pendingDir,
  promoteLockPath,
  fingerprintLockPath,
  noteLockPath,
  approvalLockPath,
  pendingLockPath,
  acquireLockFile,
  releaseLockFile,
} from './storage.ts'
import type { ConfigFile, ScannedRaw, ScanIssue, IndexSnapshot } from './storage.ts'

/* ================================================================== */
/* Secret policy (§9.7, §4.11) — fail closed on capture/update          */
/* ================================================================== */

export interface SecretRule {
  name: string
  re: RegExp
}

export const DEFAULT_SECRET_RULES: readonly SecretRule[] = [
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'stripe-live-key', re: /\bsk_live_[0-9A-Za-z]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'npm-token', re: /\bnpm_[0-9A-Za-z]{30,}\b/ },
  {
    name: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{8,}['"]?/i,
  },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}\b/i },
]

export function secretRulesFor(cfg: ConfigFile): readonly SecretRule[] {
  const extra: SecretRule[] = []
  for (const src of cfg.extra_secret_patterns ?? []) {
    try {
      extra.push({ name: `extra:${src.slice(0, 32)}`, re: new RegExp(src) })
    } catch {
      /* ignore malformed extra patterns (config-level issue, surfaced in reconcile) */
    }
  }
  return [...DEFAULT_SECRET_RULES, ...extra]
}

/** Returns the names of all matched rules. Empty = clean. */
export function scanSecrets(text: string, rules: readonly SecretRule[]): string[] {
  const hits: string[] = []
  for (const r of rules) {
    r.re.lastIndex = 0
    if (r.re.test(text)) hits.push(r.name)
    r.re.lastIndex = 0
  }
  return hits
}

export interface SecretMatch {
  rule: string
  /** JSONPath-like location; secret bytes are never included. */
  path: string
}

/** Recursively scan every string that can be serialized, with bounded paths. */
export function findSecretMatches(
  value: unknown,
  rules: readonly SecretRule[],
  root = '$',
): SecretMatch[] {
  const hits: SecretMatch[] = []
  const seen = new Set<object>()
  const visit = (current: unknown, at: string): void => {
    if (typeof current === 'string') {
      if (current === '') return
      for (const rule of rules) {
        rule.re.lastIndex = 0
        if (rule.re.test(current)) hits.push({ rule: rule.name, path: at })
        rule.re.lastIndex = 0
      }
      return
    }
    if (current === null || typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${at}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      visit(item, `${at}[${JSON.stringify(key)}]`)
    }
  }
  visit(value, root)
  return hits
}

/** Redact matched substrings before a pending-capture excerpt is persisted. */
export function redactSecrets(text: string, rules: readonly SecretRule[]): string {
  let out = text
  for (const rule of rules) {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g'
    out = out.replace(new RegExp(rule.re.source, flags), `[REDACTED:${rule.name}]`)
  }
  return out
}

function collectSecrets(cfg: ConfigFile, value: unknown, root = '$'): void {
  const hits = findSecretMatches(value, secretRulesFor(cfg), root)
  if (hits.length) {
    throw new ProjectMemoryError('POLICY_VIOLATION', `write rejected by secret policy`, {
      matched: hits.map((hit) => `${hit.rule}@${hit.path}`),
    })
  }
}

/* ================================================================== */
/* Schema / invariant validation (§15.5)                               */
/* ================================================================== */

export interface ValidationIssue {
  field?: string
  message: string
}

/**
 * Deterministic validation of a full Note (frontmatter). Returns all issues;
 * empty array = valid. Enforced before every write and re-checked by
 * reconcile. Semantic-only rules (e.g. "is this assumption really supported")
 * are NOT part of this function — they belong to humans/canonical state.
 */
export function validateNote(note: Note, opts: { idRequired?: boolean } = {}): ValidationIssue[] {
  const idRequired = opts.idRequired ?? true
  const issues: ValidationIssue[] = []
  const bad = (field: string, message: string) => issues.push({ field, message })

  if (note.schema_version !== SCHEMA_VERSION)
    bad('schema_version', `must be ${SCHEMA_VERSION}`)
  if (typeof note.project_id !== 'string' || note.project_id === '')
    bad('project_id', 'must be a non-empty string')
  const idOk =
    typeof note.id === 'string' &&
    (idRequired ? NOTE_ID_RE.test(note.id) : note.id === '' || NOTE_ID_RE.test(note.id))
  if (!idOk)
    bad('id', idRequired ? `must match ${NOTE_ID_RE}` : `must match ${NOTE_ID_RE} or be empty before allocation`)
  if (typeof note.type !== 'string' || !NOTE_TYPES.includes(note.type as NoteType))
    bad('type', `must be one of ${NOTE_TYPES.join(', ')}`)
  if (typeof note.type === 'string' && NOTE_TYPES.includes(note.type as NoteType)) {
    const type = note.type as NoteType
    if (!isLegalStatus(type, note.status)) bad('status', `illegal status "${note.status}" for type ${type}`)
    // 'promoted' is only reachable through promote() (which sets the promotion
    // record in the same write); the inverse is checked below.
    const promotionStatus =
      note.promotion && typeof note.promotion === 'object' ? note.promotion.status : undefined
    if (note.status === 'promoted' && promotionStatus !== 'promoted')
      bad('status', 'status "promoted" requires the promotion record (promote() must be used)')
    if (promotionStatus === 'promoted' && note.status !== 'promoted')
      bad('promotion.status', 'promotion record says promoted but note status is not "promoted"')
    const m = NOTE_ID_RE.exec(note.id)
    if (m && TYPE_ABBR[type] !== m[1]) bad('id', `id prefix ${m[1]} does not match type ${type}`)
  }
  if (typeof note.title !== 'string' || note.title.trim() === '')
    bad('title', 'must be non-empty')
  if (typeof note.summary !== 'string' || note.summary.trim() === '')
    bad('summary', 'must be non-empty')
  if (typeof note.rationale !== 'string' || note.rationale.trim() === '')
    bad('rationale', 'must be non-empty')
  if (typeof note.next_action !== 'string' || note.next_action.trim() === '')
    bad('next_action', 'must be non-empty')
  // Authority invariant (§7.2): notes in .project-memory can only ever be
  // 'memory' — 'canonical'/'source' exist only on the canonical side.
  if (note.authority !== 'memory')
    bad(
      'authority',
      `notes in .project-memory must have authority "memory", got ${JSON.stringify(note.authority)} (canonical/source belong to the canonical side only — §7.2)`,
    )
  if (note.priority !== undefined && !PRIORITIES.includes(note.priority))
    bad('priority', `must be one of ${PRIORITIES.join(', ')}`)
  if (note.confidence !== undefined && !CONFIDENCES.includes(note.confidence))
    bad('confidence', `must be one of ${CONFIDENCES.join(', ')}`)
  if (note.sensitivity !== undefined && !SENSITIVITIES.includes(note.sensitivity))
    bad('sensitivity', `must be one of ${SENSITIVITIES.join(', ')}`)
  if (!REVIEW_STATUSES.includes(note.review_status))
    bad('review_status', `must be one of ${REVIEW_STATUSES.join(', ')}`)
  if (
    note.review_status === 'needs_review' &&
    (typeof note.review_reason !== 'string' || note.review_reason.trim() === '')
  ) bad('review_reason', 'needs_review requires a non-empty review_reason')
  if (note.review_status === 'clear' && note.review_reason !== null)
    bad('review_reason', 'must be null while review_status is clear')

  if (!Array.isArray(note.source_refs) || note.source_refs.length === 0)
    bad('source_refs', 'at least one source_ref is required (invariant 3)')
  else
    note.source_refs.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        bad(`source_refs[${i}]`, 'must be an object')
        return
      }
      if (!SOURCE_REF_KINDS.includes(s.kind)) bad(`source_refs[${i}].kind`, `unknown kind ${String(s.kind)}`)
      if (typeof s.ref !== 'string' || s.ref === '') bad(`source_refs[${i}].ref`, 'must be non-empty')
      if (s.turn_id !== undefined && typeof s.turn_id !== 'string')
        bad(`source_refs[${i}].turn_id`, 'must be a string when present')
      if (s.observed_at !== undefined && typeof s.observed_at !== 'string')
        bad(`source_refs[${i}].observed_at`, 'must be a string when present')
      if (s.excerpt_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(s.excerpt_sha256))
        bad(`source_refs[${i}].excerpt_sha256`, 'must be 64 lowercase hex when present')
    })

  if (typeof note.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(note.fingerprint))
    bad('fingerprint', 'must be "sha256:<64 hex>"')

  if (!Array.isArray(note.tags)) bad('tags', 'must be an array')
  else for (const t of note.tags) {
    if (typeof t !== 'string' || t.trim() === '') bad('tags', 'each tag must be a non-empty string')
  }
  if (!Array.isArray(note.related_files)) bad('related_files', 'must be an array')
  else for (const rf of note.related_files) {
    if (typeof rf?.path !== 'string' || rf.path === '') bad('related_files', 'each entry needs path')
    if (typeof rf?.relation !== 'string' || rf.relation === '') bad('related_files', 'each entry needs relation')
  }
  const relMap = (k: string, v: unknown) => {
    if (!Array.isArray(v)) {
      bad('relations', `${k} must be an array`)
      return
    }
    for (const x of v) {
      if (typeof x !== 'string' || x === '') bad('relations', `${k} entries must be non-empty strings`)
      if (k === 'supersedes' && x === note.id) bad('relations.supersedes', 'note cannot supersede itself')
    }
  }
  if (!note.relations || typeof note.relations !== 'object') bad('relations', 'must be an object')
  relMap('depends_on', note.relations?.depends_on)
  relMap('related_to', note.relations?.related_to)
  relMap('supersedes', note.relations?.supersedes)
  relMap('superseded_by', note.relations?.superseded_by)
  relMap('derived_from', note.relations?.derived_from)
  relMap('promoted_to', note.relations?.promoted_to)

  if (note.trigger !== null) {
    const tr = note.trigger
    const conditions =
      tr && typeof tr === 'object' && Array.isArray((tr as Trigger).conditions)
        ? (tr as Trigger).conditions
        : null
    if (!conditions || conditions.length === 0)
      bad('trigger', 'conditions must be a non-empty array')
    else if (tr.mode !== undefined && tr.mode !== 'all' && tr.mode !== 'any')
      bad('trigger.mode', `must be "all" or "any"`)
    conditions?.forEach((c, i) => {
      if (!c || typeof c !== 'object') {
        bad(`trigger.conditions[${i}]`, 'must be an object')
        return
      }
      const p = `trigger.conditions[${i}]`
      const checkStringList = (value: unknown): boolean =>
        Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item !== '')
      const checkNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
      if (c.kind === 'milestone') {
        if (typeof c.key !== 'string' || c.key === '') bad(p + '.key', 'must be non-empty')
        const op = c.operator ?? 'equals'
        if (!['equals', 'not_equals', 'in'].includes(op)) bad(p + '.operator', `unknown operator ${op}`)
        if (op === 'in' && !checkStringList(c.value)) bad(p + '.value', 'operator "in" requires a non-empty string[] with non-empty items')
        if (op !== 'in' && !checkNonEmptyString(c.value)) bad(p + '.value', 'requires a non-empty string value')
      } else if (c.kind === 'dependency') {
        if (typeof c.key !== 'string' || c.key === '') bad(p + '.key', 'must be non-empty')
        const op = c.operator ?? 'status_in'
        if (!['status_in', 'status_equals'].includes(op)) bad(p + '.operator', `unknown operator ${op}`)
        if (op === 'status_in') {
          if (typeof c.value === 'string') {
            if (c.value.trim() === '') bad(p + '.value', 'requires a non-empty string')
          } else if (!checkStringList(c.value)) {
            bad(p + '.value', 'requires a non-empty string or a non-empty string[] with non-empty items')
          }
        } else if (!checkNonEmptyString(c.value)) {
          bad(p + '.value', 'status_equals requires a non-empty string value')
        }
      } else {
        bad(p + '.kind', `unknown condition kind ${(c as TriggerCondition).kind}`)
      }
    })
  }

  // Invariant 5 (§15.5): active deferred work must have a trigger or an
  // explicit no-trigger reason.
  if (
    note.type === 'deferred_work' &&
    !isTerminal('deferred_work', note.status) &&
    note.trigger === null &&
    (note.no_trigger_reason === null || note.no_trigger_reason === '')
  ) {
    bad('trigger', 'active deferred_work requires a trigger or a non-empty no_trigger_reason (invariant 5)')
  }
  // Invariant 4 (§15.5): accepted decisions need explicit acceptance evidence.
  if (note.type === 'decision' && note.status === 'accepted' && !note.acceptance_evidence) {
    bad('acceptance_evidence', 'accepted decision requires explicit acceptance evidence (invariant 4)')
  }

  if (!note.created_at || !isIso(note.created_at)) bad('created_at', 'must be ISO-8601')
  if (!note.updated_at || !isIso(note.updated_at)) bad('updated_at', 'must be ISO-8601')
  if (
    !note.created_by ||
    typeof note.created_by !== 'object' ||
    !['agent', 'human', 'tool'].includes(note.created_by.kind) ||
    typeof note.created_by.id !== 'string' ||
    note.created_by.id.trim() === ''
  ) bad('created_by', 'must be { kind: agent|human|tool, id: non-empty string }')
  for (const [field, value] of [
    ['status_reason', note.status_reason],
    ['no_trigger_reason', note.no_trigger_reason],
    ['acceptance_evidence', note.acceptance_evidence],
  ] as const) {
    if (value !== null && typeof value !== 'string')
      bad(field, 'must be a string or null')
  }

  const pro = note.promotion
  if (!pro || typeof pro !== 'object' || !['not_promoted', 'promoting', 'promoted'].includes(pro.status)) {
    bad('promotion.status', `illegal promotion status`)
  } else if (pro.status === 'not_promoted') {
    if (pro.target !== null) bad('promotion.target', 'must be null while not_promoted')
    if (pro.promotion_id !== null) bad('promotion.promotion_id', 'must be null while not_promoted')
    if (pro.promoted_at !== null) bad('promotion.promoted_at', 'must be null while not_promoted')
  } else {
    if (!pro.target || typeof pro.target !== 'object')
      bad('promotion.target', 'required once promoting/promoted')
    else {
      const tgt = pro.target
      if (typeof tgt.path !== 'string' || tgt.path.trim() === '')
        bad('promotion.target.path', 'must be a non-empty string')
      else if (isUnsafeProjectRelativePath(tgt.path))
        bad(
          'promotion.target.path',
          `must be a project-relative path that cannot escape .project-memory (got ${JSON.stringify(tgt.path)})`,
        )
      if (typeof tgt.kind !== 'string' || tgt.kind.trim() === '')
        bad('promotion.target.kind', 'must be a non-empty string')
      if (typeof tgt.ref !== 'string' || tgt.ref.trim() === '')
        bad('promotion.target.ref', 'must be a non-empty string')
      for (const [field, value] of [['objectId', tgt.objectId], ['version', tgt.version]] as const) {
        if (value !== undefined && typeof value !== 'string')
          bad(`promotion.target.${field}`, 'must be a string when present')
      }
    }
    if (typeof pro.promotion_id !== 'string' || pro.promotion_id === '')
      bad('promotion.promotion_id', 'required once promoting/promoted (invariant 7)')
    if (pro.backlink !== null && !['in_file', 'link_file'].includes(pro.backlink))
      bad('promotion.backlink', `must be one of in_file|link_file|null, got ${JSON.stringify(pro.backlink)}`)
    if (typeof pro.backlink_verified !== 'boolean')
      bad('promotion.backlink_verified', 'must be a boolean')
    if (pro.promoted_at !== null && typeof pro.promoted_at !== 'string')
      bad('promotion.promoted_at', 'must be an ISO-8601 string or null')
    if (pro.status === 'promoted') {
      if (pro.backlink === null) bad('promotion.backlink', 'required when promoted (invariant 8)')
      if (!pro.backlink_verified) bad('promotion.backlink_verified', 'must be true when promoted')
      if (pro.promoted_at === null || !isIso(pro.promoted_at)) bad('promotion.promoted_at', 'required ISO-8601 when promoted')
    }
  }

  return issues
}

function isIso(s: string): boolean {
  return !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s)
}

/* ================================================================== */
/* Service                                                             */
/* ================================================================== */

export interface InitProjectOptions {
  project_id: string
  extra_secret_patterns?: string[]
  /**
   * Optional project-relative canonical state file (milestone statuses) for
   * lazy trigger evaluation. Must live inside the project, outside
   * .project-memory. When unset, triggers are not evaluated — never guessed.
   */
  canonical_state_file?: string
}

export interface CaptureInput {
  type: NoteType
  title: string
  summary: string
  rationale: string
  /** Optional markdown body (e.g. "## Context …"). */
  body?: string
  status?: string
  priority?: Priority
  tags?: string[]
  /** Always 'memory' for notes stored in .project-memory (§7.2). */
  authority?: NoteAuthority
  confidence?: Confidence
  sensitivity?: Sensitivity
  source_refs: SourceRef[]
  related_files?: RelatedFile[]
  relations?: Partial<Relations>
  trigger?: Trigger | null
  no_trigger_reason?: string | null
  next_action: string
  status_reason?: string | null
  acceptance_evidence?: string | null
  created_by?: { kind: 'agent' | 'human' | 'tool'; id: string }
}

export type CaptureReceipt =
  | { status: 'created'; id: string; fingerprint: string; file: string; note: Note }
  | {
      status: 'merged'
      id: string
      fingerprint: string
      file: string
      note: Note
      added_sources: SourceRef[]
    }

export interface UpdatePatch {
  title?: string
  summary?: string
  rationale?: string
  /** By default rationale updates append a dated note instead of overwriting (§4.8). */
  overwriteRationale?: boolean
  body?: string
  status?: string
  status_reason?: string
  priority?: Priority
  tags?: string[]
  /** Always 'memory' for notes stored in .project-memory (§7.2). */
  authority?: NoteAuthority
  confidence?: Confidence
  sensitivity?: Sensitivity
  review_status?: ReviewStatus
  review_reason?: string | null
  next_action?: string
  trigger?: Trigger | null
  no_trigger_reason?: string | null
  acceptance_evidence?: string | null
  related_files?: RelatedFile[]
  relations?: Partial<Relations>
}

export interface CloseOptions {
  status: string
  /** Required: provenance requires a state-change reason (§14.4). */
  status_reason: string
  body?: string
}

export interface SearchQuery {
  text?: string
  id?: string
  type?: NoteType
  statuses?: string[]
  priority?: Priority
  tags?: string[]
  authority?: Authority
  relatedFile?: string
  /** Requires `state`. Includes notes whose trigger is currently due. */
  due?: boolean
  state?: TriggerState
  includeTerminal?: boolean
  limit?: number
}

export interface SearchHit {
  note: Note
  file: string
  body: string
  textMatched: boolean
  /** Effective review state, including trusted canonical-conflict adapter output. */
  reviewStatus: ReviewStatus
  canonicalConflict?: CanonicalConflictEvidence
  relevanceScore?: number
  relevanceTerms?: string[]
  /** Present when state was supplied and the note has a trigger. */
  triggerEval?: TriggerResult
}

export type PromotionMode = 'replace_file' | 'append_block'

export interface PromotionRequest {
  promotion_id: string
  target: Omit<CanonicalTarget, 'ref'> & { ref?: string }
  /**
   * Exact new content for the canonical target (text targets only:
   * .md/.markdown/.txt). Idempotent: skipped when the file already matches.
   * Exactly one of `content` / `insertBlock` is required (§12.3 step 6).
   */
  content?: string
  /**
   * Exact Markdown block appended to the canonical target (.md/.markdown
   * only). Idempotent: skipped when the block is already present.
   */
  insertBlock?: string
}

export interface PromotionPlan {
  project_id: string
  note_id: string
  promotion_id: string
  target: CanonicalTarget
  mode: PromotionMode
  /** Exact replace payload or append block shown to the approving user. */
  payload_content: string
  payload_sha256: string
  before_sha256: string
  after_sha256: string
  planned_at: string
  before_content: string
  after_content: string
}

export interface PromotionApprovalRecord {
  schema_version: 1
  approval_ref: string
  project_id: string
  note_id: string
  promotion_id: string
  target: CanonicalTarget
  mode: PromotionMode
  payload_sha256: string
  before_sha256: string
  after_sha256: string
  planned_at: string
  approved_at: string
  approved_by: { kind: 'human'; id: string; channel: 'pi-ui' }
  status: 'approved' | 'consumed'
  consumed_at: string | null
}

export interface PromoteOptions extends PromotionRequest {
  /** Single-use durable record minted only after an external user confirmation. */
  approval_ref: string
}

export interface PromoteReceipt {
  status: 'promoted' | 'replayed'
  id: string
  promotion_id: string
  target: CanonicalTarget
  note: Note
  backlink: { mode: BacklinkMode; targetPath: string; verified: boolean }
  approval_ref: string
}

export interface PendingCaptureResolution {
  status: 'captured' | 'skipped'
  resolved_at: string
  tool_call_id: string
  note_id?: string
  reason?: string
}

export interface PendingCaptureCandidate {
  candidate_id: string
  type: NoteType
  markers: string[]
  source_ref: SourceRef
  source_excerpt: string
  source_excerpt_sha256: string
  detected_at: string
  resolution: PendingCaptureResolution | null
}

export interface PendingCaptureEnvelope {
  schema_version: 1
  envelope_id: string
  project_id: string
  session_id: string
  source_leaf_id: string
  created_at: string
  candidates: PendingCaptureCandidate[]
}

export type ReconcileSeverity = 'error' | 'warning'

export interface ReconcileIssue {
  severity: ReconcileSeverity
  code: string
  noteId?: string
  file?: string
  message: string
}

export interface ReconcileReport {
  project_id: string
  ran_at: string
  notes_scanned: number
  issues: ReconcileIssue[]
  auto_fixed: string[]
  index: { existed: boolean; rebuilt: boolean; notes_indexed: number; triggers_indexed: number }
}

export class ProjectMemory {
  readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    assertProjectDir(cwd)
  }

  /* ---------------- lifecycle ---------------- */

  init(opts: InitProjectOptions): { config: ConfigFile; created: boolean } {
    return initProjectStorage(this.cwd, opts)
  }

  config(): ConfigFile {
    return readConfig(this.cwd)
  }

  /* ---------------- capture (§9, §10.3, §15.2) ---------------- */

  capture(input: CaptureInput): CaptureReceipt {
    const cfg = readConfig(this.cwd)

    if (!NOTE_TYPES.includes(input.type))
      throw new ProjectMemoryError('INVALID_INPUT', `unknown type "${input.type}"`)
    for (const field of ['title', 'summary', 'rationale', 'next_action'] as const) {
      if (typeof input[field] !== 'string' || input[field].trim() === '')
        throw new ProjectMemoryError('INVALID_INPUT', `${field} must be a non-empty string`)
    }
    if (!Array.isArray(input.source_refs) || input.source_refs.length === 0)
      throw new ProjectMemoryError('INVALID_INPUT', 'capture requires at least one source_ref')
    if (input.status !== undefined && !isLegalStatus(input.type, input.status))
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        `illegal status "${input.status}" for type ${input.type} (legal: ${STATUSES[input.type].join(', ')})`,
      )
    if (input.authority !== undefined && input.authority !== 'memory')
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        `capture authority must be "memory", got ${JSON.stringify(input.authority)} (notes cannot claim canonical/source authority — §7.2)`,
      )

    const now = new Date().toISOString()
    const fingerprint = fingerprintOf(input.type, input.title, input.summary)
    const body = input.body ?? ''
    const note: Note = {
      schema_version: SCHEMA_VERSION,
      id: '',
      project_id: cfg.project_id,
      type: input.type,
      status: input.status ?? DEFAULT_STATUS[input.type],
      fingerprint,
      title: input.title.trim(),
      summary: input.summary.trim(),
      rationale: input.rationale.trim(),
      priority: input.priority,
      authority: input.authority ?? 'memory',
      confidence: input.confidence ?? 'unverified',
      sensitivity: input.sensitivity,
      review_status: 'clear',
      review_reason: null,
      tags: input.tags ?? [],
      source_refs: input.source_refs,
      related_files: input.related_files ?? [],
      relations: { ...emptyRelations(), ...(input.relations ?? {}) },
      trigger: input.trigger ?? null,
      no_trigger_reason: input.no_trigger_reason ?? null,
      next_action: input.next_action.trim(),
      status_reason: input.status_reason ?? null,
      acceptance_evidence: input.acceptance_evidence ?? null,
      created_by: input.created_by ?? { kind: 'tool', id: 'project-memory' },
      created_at: now,
      updated_at: now,
      promotion: defaultPromotionInfo(),
    }
    collectSecrets(cfg, { note, body }, '$capture')
    const preIssues = validateNote(note, { idRequired: false })
    if (preIssues.length)
      throw new ProjectMemoryError('INVALID_INPUT', `capture rejected by schema: ${formatIssues(preIssues)}`, {
        issues: preIssues,
      })

    // The fingerprint lock spans the in-lock rescan and create/merge. This is
    // the semantic uniqueness boundary across independent Pi/Node processes.
    const lockPath = fingerprintLockPath(this.cwd, fingerprint)
    const lockFd = acquireLockFile(
      lockPath,
      { operation: 'capture', fingerprint, type: input.type },
      { waitMs: 15_000, retryMs: 5 },
    )
    try {
      const existing = this.scan().notes.find(
        (candidate) =>
          candidate.note.fingerprint === fingerprint &&
          candidate.note.type === input.type &&
          !isTerminalNote(candidate.note),
      )
      if (existing) {
        const merged = this.mergeInto(existing, input, fingerprint, now, cfg)
        if (merged) return merged
      }

      const { id, file } = createNoteFileExclusive(this.cwd, note, body)
      const finalNote: Note = { ...note, id }
      const postIssues = validateNote(finalNote)
      if (postIssues.length)
        throw new ProjectMemoryError(
          'INTERNAL',
          `capture post-allocation validation failed: ${formatIssues(postIssues)}`,
          { issues: postIssues, id },
        )
      this.rebuildIndex()
      return { status: 'created', id, fingerprint, file, note: finalNote }
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  private mergeInto(
    existing: ScannedNote,
    input: CaptureInput,
    fingerprint: string,
    now: string,
    cfg: ConfigFile,
  ): CaptureReceipt | null {
    const lockPath = noteLockPath(this.cwd, existing.note.id)
    const lockFd = acquireLockFile(
      lockPath,
      { operation: 'capture-merge', note_id: existing.note.id },
      { waitMs: 15_000, retryMs: 5 },
    )
    try {
      const current = this.read(existing.note.id)
      if (
        !current ||
        current.note.fingerprint !== fingerprint ||
        current.note.type !== input.type ||
        isTerminalNote(current.note)
      ) return null

      const note = structuredClone(current.note)
      const added: SourceRef[] = []
      const have = new Set(note.source_refs.map(sourceKey))
      for (const source of input.source_refs) {
        if (!have.has(sourceKey(source))) {
          note.source_refs.push(source)
          have.add(sourceKey(source))
          added.push(source)
        }
      }
      for (const tag of input.tags ?? []) if (!note.tags.includes(tag)) note.tags.push(tag)
      for (const related of input.related_files ?? [])
        if (!note.related_files.some((item) => item.path === related.path && item.relation === related.relation))
          note.related_files.push(related)
      const mergeRelation = (key: keyof Relations, values?: string[]) => {
        for (const value of values ?? []) if (!note.relations[key].includes(value)) note.relations[key].push(value)
      }
      mergeRelation('depends_on', input.relations?.depends_on)
      mergeRelation('related_to', input.relations?.related_to)
      mergeRelation('supersedes', input.relations?.supersedes)
      mergeRelation('superseded_by', input.relations?.superseded_by)
      mergeRelation('derived_from', input.relations?.derived_from)
      mergeRelation('promoted_to', input.relations?.promoted_to)
      if (note.trigger === null && input.trigger) note.trigger = input.trigger
      note.updated_at = now
      note.fingerprint = fingerprint

      collectSecrets(cfg, { note, body: current.body }, '$merge')
      const issues = validateNote(note)
      if (issues.length)
        throw new ProjectMemoryError('INVALID_INPUT', `merge rejected by schema: ${formatIssues(issues)}`, {
          issues,
          mergedInto: note.id,
        })
      const sha256 = writeNoteFileCas(current.file, current.sha256, note, current.body)
      this.rebuildIndex()
      return {
        status: 'merged',
        id: note.id,
        fingerprint,
        file: current.file,
        note,
        added_sources: added,
      }
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  /* ---------------- read / search ---------------- */

  /** Whole-store trusted scan. Invalid, foreign-project, or secret-bearing notes are quarantined. */
  scan(): { notes: ScannedNote[]; errors: ScanIssue[]; duplicates: string[] } {
    const cfg = readConfig(this.cwd)
    const { notes: raws, errors } = scanNotes(this.cwd)
    const notes: ScannedNote[] = []
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    const rules = secretRulesFor(cfg)
    for (const raw of raws) {
      const hyd = hydrateNote(raw)
      if (!hyd) {
        errors.push({ file: raw.file, message: 'note hydration failed' })
        continue
      }
      let validation: ValidationIssue[]
      try {
        validation = validateNote(hyd.note)
      } catch {
        validation = [{ message: 'validator rejected malformed structure' }]
      }
      if (validation.length > 0) {
        errors.push({ file: raw.file, message: `note schema invalid: ${formatIssues(validation)}` })
        continue
      }
      if (hyd.note.project_id !== cfg.project_id) {
        errors.push({
          file: raw.file,
          message: `project_id mismatch: expected ${cfg.project_id}, got ${hyd.note.project_id}`,
        })
        continue
      }
      if (hyd.note.promotion.status !== 'not_promoted' && hyd.note.promotion.target) {
        const targetPath = hyd.note.promotion.target.path
        try {
          const rel = assertProjectRelativePath(this.cwd, targetPath, 'promotion target')
          rejectSymlinkComponents(this.cwd, path.join(this.cwd, rel), 'promotion target', 'INCONSISTENT')
          if (hyd.note.promotion.status === 'promoted') {
            const abs = path.join(this.cwd, rel)
            if (!fs.existsSync(abs)) {
              throw new ProjectMemoryError('INCONSISTENT', `promotion target missing for promoted note: ${rel}`)
            }
            if (!fs.statSync(abs).isFile()) {
              throw new ProjectMemoryError(
                'INCONSISTENT',
                `promotion target is not a regular file for promoted note: ${rel} (${fs.statSync(abs).isDirectory() ? 'directory' : 'non-regular'})`,
              )
            }
          }
        } catch (error) {
          errors.push({
            file: raw.file,
            message: `promotion target invalid: ${error instanceof Error ? error.message : String(error)}`,
          })
          continue
        }
      }
      const secretHits = findSecretMatches({ note: raw.noteObj, body: raw.body }, rules, '$noteFile')
      if (secretHits.length > 0) {
        errors.push({
          file: raw.file,
          message: `secret policy violation at ${secretHits.map((hit) => `${hit.rule}@${hit.path}`).join(', ')}`,
        })
        continue
      }
      const prev = seen.get(hyd.note.id)
      if (prev) duplicates.push(`${hyd.note.id} (${prev} and ${raw.file})`)
      seen.set(hyd.note.id, raw.file)
      notes.push(hyd)
    }
    return { notes, errors, duplicates }
  }

  read(id: string): ScannedNote | null {
    // Fail-closed (§4.10): reads also require project identity — an
    // unconfigured dir must not quietly look like "no memory".
    readConfig(this.cwd)
    const { notes, duplicates } = this.scan()
    const found = notes.filter((n) => n.note.id === id)
    if (duplicates.length > 0) {
      const dups = duplicates.filter((d) => d.startsWith(id))
      if (dups.length > 0)
        throw new ProjectMemoryError('INCONSISTENT', `duplicate note id ${id} — run reconcile`, { duplicates: dups })
    }
    return found[0] ?? null
  }

  search(query: SearchQuery = {}): SearchHit[] {
    // Fail-closed (§4.10): reads also require project identity.
    readConfig(this.cwd)
    if (query.due && !query.state)
      throw new ProjectMemoryError('INVALID_INPUT', 'search(due:true) requires state')
    const { notes } = this.scan()
    const q = query.text?.trim()
    const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : []
    const hits: SearchHit[] = []
    const statusFilter = query.statuses?.length ? new Set(query.statuses) : null
    const tagFilter = query.tags?.length ? new Set(query.tags) : null
    const statusMap = new Map(notes.map((nn) => [nn.note.id, nn.note.status]))

    for (const { note: n, file, body, sha256 } of notes) {
      if (query.id !== undefined) {
        if (n.id !== query.id) continue
      } else {
        if (query.type !== undefined && n.type !== query.type) continue
        if (statusFilter && !statusFilter.has(n.status)) continue
        if (query.priority !== undefined && n.priority !== query.priority) continue
        if (tagFilter && !n.tags.some((t) => tagFilter.has(t))) continue
        if (query.authority !== undefined && n.authority !== query.authority) continue
        if (query.relatedFile !== undefined && !n.related_files.some((rf) => rf.path.includes(query.relatedFile!)))
          continue
        if (!query.includeTerminal && isTerminalNote(n)) continue
      }
      const haystack = [
        n.title,
        n.summary,
        n.rationale,
        n.next_action,
        n.tags.join(' '),
        body,
      ]
        .join('\n')
        .toLowerCase()
      const textMatched = tokens.length > 0 && tokens.every((t) => haystack.includes(t))
      if (tokens.length > 0 && !textMatched) continue

      let triggerEval: TriggerResult | undefined
      if (query.state && n.trigger && !isTerminalNote(n)) {
        triggerEval = this.evaluateTrigger(n, query.state, statusMap)
        if (query.due && triggerEval.state !== 'due') continue
      }
      const rawConflict = query.state?.canonical_conflicts?.[n.id]
      // Only evidence bound to the current note revision is effective; stale
      // evidence (note_sha256 mismatch) must not pollute retrieval.
      const canonicalConflict =
        rawConflict && (!rawConflict.note_sha256 || rawConflict.note_sha256 === sha256)
          ? rawConflict
          : undefined
      hits.push({
        note: n,
        file,
        body,
        textMatched,
        triggerEval,
        canonicalConflict,
        reviewStatus: canonicalConflict ? 'needs_review' : n.review_status,
      })
    }

    const score = (h: SearchHit) => {
      let s = 0
      if (query.id !== undefined && h.note.id === query.id) s -= 1000
      else if (h.textMatched) s -= 10
      s -= new Date(h.note.updated_at).getTime() / 1e12
      return s
    }
    hits.sort((a, b) => score(a) - score(b))
    const limit = query.limit ?? 20
    return hits.slice(0, limit)
  }

  /* ---------------- update / close ---------------- */

  update(id: string, patch: UpdatePatch): ScannedNote {
    if (!NOTE_ID_RE.test(id))
      throw new ProjectMemoryError('INVALID_INPUT', `note id must match ${NOTE_ID_RE}`, { id })
    const cfg = readConfig(this.cwd)
    const forbidden = ['id', 'project_id', 'type', 'schema_version', 'source_refs', 'created_at', 'created_by', 'promotion', 'fingerprint'] as const
    for (const key of forbidden) {
      if (key in patch)
        throw new ProjectMemoryError('INVALID_INPUT', `field "${key}" is immutable via update`)
    }

    const lockPath = noteLockPath(this.cwd, id)
    const lockFd = acquireLockFile(
      lockPath,
      { operation: 'update', note_id: id },
      { waitMs: 15_000, retryMs: 5 },
    )
    try {
      const found = this.read(id)
      if (!found) throw new ProjectMemoryError('NOT_FOUND', `no trusted note with id ${id}`, { id })
      const note = structuredClone(found.note)
      if (patch.title !== undefined && patch.title !== note.title) note.title = patch.title.trim()
      if (patch.summary !== undefined && patch.summary !== note.summary) note.summary = patch.summary.trim()
      if (patch.rationale !== undefined) {
        const trimmed = patch.rationale.trim()
        if (patch.overwriteRationale || !note.rationale) note.rationale = trimmed
        else if (trimmed && trimmed !== note.rationale)
          note.rationale = `${note.rationale}\n\n[updated ${new Date().toISOString()}] ${trimmed}`
      }
      if (patch.status !== undefined) {
        if (!isLegalStatus(note.type, patch.status))
          throw new ProjectMemoryError(
            'INVALID_INPUT',
            `illegal status "${patch.status}" for type ${note.type} (legal: ${STATUSES[note.type].join(', ')})`,
          )
        note.status = patch.status
      }
      if (patch.status_reason !== undefined) note.status_reason = patch.status_reason
      if (patch.priority !== undefined) note.priority = patch.priority
      if (patch.tags !== undefined) note.tags = patch.tags
      if (patch.authority !== undefined) {
        if (patch.authority !== 'memory')
          throw new ProjectMemoryError(
            'INVALID_INPUT',
            `update authority must be "memory", got ${JSON.stringify(patch.authority)} (notes cannot claim canonical/source authority — §7.2)`,
          )
        note.authority = patch.authority
      }
      if (patch.confidence !== undefined) note.confidence = patch.confidence
      if (patch.sensitivity !== undefined) note.sensitivity = patch.sensitivity
      if (patch.review_status !== undefined) {
        note.review_status = patch.review_status
        if (patch.review_status === 'clear' && patch.review_reason === undefined) note.review_reason = null
      }
      if ('review_reason' in patch) note.review_reason = patch.review_reason ?? null
      if (patch.next_action !== undefined) note.next_action = patch.next_action.trim()
      if ('trigger' in patch) note.trigger = patch.trigger ?? null
      if ('no_trigger_reason' in patch) note.no_trigger_reason = patch.no_trigger_reason ?? null
      if ('acceptance_evidence' in patch) note.acceptance_evidence = patch.acceptance_evidence ?? null
      if (patch.related_files !== undefined) note.related_files = patch.related_files
      if (patch.relations !== undefined) {
        for (const key of Object.keys(patch.relations) as (keyof Relations)[]) {
          note.relations[key] = patch.relations[key] ?? []
        }
      }

      note.fingerprint = fingerprintOf(note.type, note.title, note.summary)
      note.updated_at = new Date().toISOString()
      const finalBody = patch.body !== undefined ? patch.body : found.body
      collectSecrets(cfg, { note, body: finalBody }, '$update')
      const issues = validateNote(note)
      if (issues.length)
        throw new ProjectMemoryError('INVALID_INPUT', `update rejected by schema: ${formatIssues(issues)}`, {
          issues,
          id,
        })
      const duplicate = this.scan().notes.find(
        (candidate) =>
          candidate.note.id !== id &&
          candidate.note.fingerprint === note.fingerprint &&
          !isTerminalNote(candidate.note),
      )
      if (duplicate)
        throw new ProjectMemoryError('CONFLICT', `update would duplicate active note ${duplicate.note.id}`, {
          id,
          duplicate: duplicate.note.id,
          fingerprint: note.fingerprint,
        })
      const sha256 = writeNoteFileCas(found.file, found.sha256, note, finalBody)
      this.rebuildIndex()
      return { note, file: found.file, body: finalBody, sha256 }
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  close(id: string, opts: CloseOptions): ScannedNote {
    if (typeof opts.status_reason !== 'string' || opts.status_reason.trim() === '')
      throw new ProjectMemoryError('INVALID_INPUT', 'close requires a non-empty status_reason (provenance §14.4)')
    const found = this.read(id)
    if (!found) throw new ProjectMemoryError('NOT_FOUND', `no note with id ${id}`, { id })
    const type = found.note.type
    if (!isLegalStatus(type, opts.status))
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        `illegal close status "${opts.status}" for type ${type} (legal: ${STATUSES[type].join(', ')})`,
      )
    if (!isTerminal(type, opts.status)) {
      throw new ProjectMemoryError('INVALID_INPUT', `close() only accepts terminal statuses for ${type}`)
    }
    return this.update(id, {
      status: opts.status,
      status_reason: opts.status_reason.trim(),
      body: opts.body,
    })
  }

  /* ---------------- triggers (§11.6–§11.8, lazy) ---------------- */

  /**
   * Load the configured canonical state file (project-relative, outside
   * .project-memory) for lazy trigger evaluation. Returns null when unset or
   * the file does not exist yet — triggers are then NOT evaluated, never
   * guessed (§11.8). Throws INCONSISTENT when the file exists but its shape
   * is not a milestone map. This loader never reads notes or anything under
   * .project-memory, so notes can never self-trigger (§11.7).
   */
  loadCanonicalState(): TriggerState | null {
    const cfg = readConfig(this.cwd)
    if (!cfg.canonical_state_file) return null
    const rel = assertProjectRelativePath(this.cwd, cfg.canonical_state_file, 'canonical_state_file')
    // Symlink fail-closed: the state file (and every component down to it)
    // must be a real file inside the project — never a link to content outside.
    rejectSymlinkComponents(this.cwd, path.join(this.cwd, rel), 'canonical_state_file', 'INCONSISTENT')
    const content = tryReadText(path.join(this.cwd, rel))
    if (content === null) return null
    const bad = (msg: string): never => {
      throw new ProjectMemoryError('INCONSISTENT', `canonical state file ${rel}: ${msg}`, { path: rel })
    }
    let parsed: unknown
    try {
      parsed = yaml.parse(content)
    } catch {
      bad('unparsable YAML/JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      bad('must be a YAML/JSON object')
    const obj = parsed as Record<string, unknown>
    const stringMap = (value: unknown, label: string): Record<string, string> => {
      if (value === undefined || value === null) return {}
      if (typeof value !== 'object' || Array.isArray(value)) bad(`${label} must be a map of string values`)
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== 'string')
          throw new ProjectMemoryError('INCONSISTENT', `${label}.${k} must be a string`, { path: rel })
        out[k] = v
      }
      return out
    }
    if (!('milestones' in obj)) bad('missing required "milestones" map')
    const milestones = stringMap(obj.milestones, 'milestones')
    const noteStatuses = stringMap(obj.noteStatuses, 'noteStatuses')
    const canonicalConflicts: Record<string, CanonicalConflictEvidence> = {}
    if (obj.canonical_conflicts !== undefined && obj.canonical_conflicts !== null) {
      if (typeof obj.canonical_conflicts !== 'object' || Array.isArray(obj.canonical_conflicts))
        bad('canonical_conflicts must be a map keyed by Note ID')
      for (const [id, rawEvidence] of Object.entries(obj.canonical_conflicts as Record<string, unknown>)) {
        if (!NOTE_ID_RE.test(id)) bad(`canonical_conflicts key ${id} must be a valid Note ID`)
        if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence))
          bad(`canonical_conflicts.${id} must be an object`)
        const evidence = rawEvidence as Record<string, unknown>
        if (typeof evidence.canonical_ref !== 'string' || evidence.canonical_ref.trim() === '')
          bad(`canonical_conflicts.${id}.canonical_ref must be non-empty`)
        if (typeof evidence.reason !== 'string' || evidence.reason.trim() === '')
          bad(`canonical_conflicts.${id}.reason must be non-empty`)
        if (evidence.observed_at !== undefined && (typeof evidence.observed_at !== 'string' || !isIso(evidence.observed_at)))
          bad(`canonical_conflicts.${id}.observed_at must be ISO-8601`)
        if (evidence.note_sha256 !== undefined && (typeof evidence.note_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.note_sha256)))
          bad(`canonical_conflicts.${id}.note_sha256 must be 64 lowercase hex`)
        canonicalConflicts[id] = {
          canonical_ref: evidence.canonical_ref as string,
          reason: evidence.reason as string,
          ...(typeof evidence.observed_at === 'string' ? { observed_at: evidence.observed_at } : {}),
          ...(typeof evidence.note_sha256 === 'string' ? { note_sha256: evidence.note_sha256 } : {}),
        }
      }
    }
    const state: TriggerState = { milestones }
    if (Object.keys(noteStatuses).length > 0) state.noteStatuses = noteStatuses
    if (Object.keys(canonicalConflicts).length > 0) state.canonical_conflicts = canonicalConflicts
    return state
  }

  /**
   * Evaluate all triggers against canonical state. With no state argument the
   * configured canonical_state_file is loaded; if it is unset or the file is
   * absent, the evaluation is skipped entirely (unevaluated: true) — triggers
   * are never guessed (§11.8).
   */
  evaluateTriggers(state?: TriggerState, opts: { includeNotDue?: boolean } = {}): TriggerEvaluation {
    if (state === undefined) {
      const loaded = this.loadCanonicalState()
      if (loaded === null) return { due: [], unresolved: [], not_due: [], unevaluated: true }
      state = loaded
    }
    const { notes } = this.scan()
    const statusLookup = new Map<string, string>()
    for (const { note } of notes) statusLookup.set(note.id, note.status)
    const due: TriggerResult[] = []
    const unresolved: TriggerResult[] = []
    const not_due: TriggerResult[] = []
    for (const { note: n, sha256 } of notes) {
      if (!n.trigger || isTerminalNote(n)) continue
      const r = this.evaluateTrigger(n, state, statusLookup, state.noteStatuses)
      const tagged = { ...r, note_sha256: sha256 }
      if (r.state === 'due') due.push(tagged)
      else if (r.state === 'unresolved') unresolved.push(tagged)
      else if (opts.includeNotDue) not_due.push(tagged)
    }
    return { due, unresolved, not_due }
  }

  /** Working set for OnTaskStart: due triggers + prompt-ranked active memory. */
  taskStartRetrieval(
    opts: { state?: TriggerState; types?: NoteType[]; text?: string; limit?: number } = {},
  ): { due: TriggerResult[]; active: SearchHit[] } {
    const state = opts.state ?? this.loadCanonicalState()
    const due = state ? this.evaluateTriggers(state).due : []
    let active = this.search({ includeTerminal: false, state: state ?? undefined, limit: 500 }).filter((hit) =>
      opts.types ? opts.types.includes(hit.note.type) : true,
    )
    const terms = lexicalTerms(opts.text ?? '')
    if (terms.length > 0) {
      active = active
        .map((hit) => {
          const scored = scoreTaskRelevance(hit, terms)
          return { ...hit, relevanceScore: scored.score, relevanceTerms: scored.terms }
        })
        .filter((hit) => (hit.relevanceScore ?? 0) > 0)
        .sort(
          (left, right) =>
            (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
            new Date(right.note.updated_at).getTime() - new Date(left.note.updated_at).getTime(),
        )
    }
    return { due, active: active.slice(0, opts.limit ?? 20) }
  }

  private evaluateTrigger(
    note: Note,
    state: TriggerState,
    statusLookup?: Map<string, string>,
    statusOverride?: Record<string, string>,
  ): TriggerResult {
    const tr = note.trigger!
    const evals: ConditionEval[] = []
    const statusOf = (key: string): string | undefined => {
      if (statusOverride && key in statusOverride) return statusOverride[key]
      return statusLookup?.get(key)
    }
    for (let i = 0; i < tr.conditions.length; i++) {
      const c = tr.conditions[i]
      let label = ''
      let truth: ConditionEval['truth'] = 'unknown'
      if (c.kind === 'milestone') {
        const val = state.milestones[c.key]
        const op = c.operator ?? 'equals'
        label = `milestone:${c.key}=${val === undefined ? '?' : val}`
        if (val !== undefined) {
          if (op === 'in') truth = Array.isArray(c.value) && c.value.includes(val) ? 'satisfied' : 'unsatisfied'
          else if (op === 'not_equals') truth = val === c.value ? 'unsatisfied' : 'satisfied'
          else truth = val === c.value ? 'satisfied' : 'unsatisfied'
        }
      } else {
        const status = statusOf(c.key)
        const op = c.operator ?? 'status_in'
        label = `dependency:${c.key}=${status === undefined ? '?' : status}`
        if (status !== undefined) {
          if (op === 'status_equals') truth = status === c.value ? 'satisfied' : 'unsatisfied'
          else truth = (Array.isArray(c.value) ? c.value : [c.value]).includes(status) ? 'satisfied' : 'unsatisfied'
        }
      }
      evals.push({ index: i, label, truth })
    }

    const mode = tr.mode ?? 'all'
    const unknowns = evals.filter((e) => e.truth === 'unknown')
    const satisfied = evals.filter((e) => e.truth === 'satisfied').length
    const base: TriggerResult = {
      id: note.id,
      type: note.type,
      status: note.status,
      title: note.title,
      summary: note.summary,
      next_action: note.next_action,
      trigger: tr,
      conditions: evals,
      state: 'not_due',
    }
    if (evals.length === 0) return { ...base, state: 'unresolved', reason: 'trigger:no_conditions' }
    if (mode === 'all') {
      if (unknowns.length > 0)
        return { ...base, state: 'unresolved', reason: unknowns.map((e) => e.label).join('; ') }
      if (satisfied === evals.length) return { ...base, state: 'due' }
      return base
    }
    // mode: any
    if (satisfied > 0) return { ...base, state: 'due' }
    if (unknowns.length > 0)
      return { ...base, state: 'unresolved', reason: unknowns.map((e) => e.label).join('; ') }
    return base
  }

  /* ---------------- promote (§12) ---------------- */

  /** Build the exact, hash-bound canonical bytes that the user must review. */
  planPromotion(id: string, request: PromotionRequest): PromotionPlan {
    if (!NOTE_ID_RE.test(id))
      throw new ProjectMemoryError('INVALID_INPUT', `note id must match ${NOTE_ID_RE}`, { id })
    const cfg = readConfig(this.cwd)
    const found = this.read(id)
    if (!found) throw new ProjectMemoryError('NOT_FOUND', `no trusted note with id ${id}`, { id })
    if (found.note.promotion.status === 'promoting' && found.note.promotion.promotion_id !== request.promotion_id)
      throw new ProjectMemoryError('CONFLICT', `note ${id} is already in another promotion transaction`)
    if (isTerminal(found.note.type, found.note.status) && found.note.status !== 'promoted')
      throw new ProjectMemoryError('INVALID_INPUT', `cannot promote terminal note ${id} (status ${found.note.status})`)

    const prepared = resolvePromotionTarget(this.cwd, request)
    collectSecrets(cfg, { target: prepared.target, payload: prepared.payload }, '$promotionPlan')
    const before = tryReadText(prepared.abs)
    if (before === null) throw new ProjectMemoryError('CONFLICT', `canonical target disappeared: ${prepared.rel}`)
    const marker = IN_FILE_MARKER_RE.exec(before)
    if (marker && !(marker[1] === id && marker[2] === request.promotion_id))
      throw new ProjectMemoryError('CONFLICT', 'canonical target already carries another memory backlink', {
        target: prepared.rel,
        existingNote: marker[1],
        existingPromotion: marker[2],
      })
    const plannedAt = new Date().toISOString()
    const after = buildCanonicalAfterContent(
      before,
      prepared,
      id,
      request.promotion_id,
      plannedAt,
    )
    return {
      project_id: cfg.project_id,
      note_id: id,
      promotion_id: request.promotion_id,
      target: prepared.target,
      mode: prepared.mode,
      payload_content: prepared.payload,
      payload_sha256: sha256hex(prepared.payload),
      before_sha256: sha256hex(before),
      after_sha256: sha256hex(after),
      planned_at: plannedAt,
      before_content: before,
      after_content: after,
    }
  }

  /** Persist a single-use approval only after a trusted UI has confirmed the plan.
   *
   * Trust boundary (recorded assumption): this Core API asserts, but cannot
   * prove, that the caller performed a live user confirmation. The real UI
   * gate lives in the Pi Extension layer (ctx.hasUI + direct confirm dialog +
   * exact-bytes display). Core pinning here means: channel must be 'pi-ui', the
   * principal id must be a pi-session:// URI, and the approval is bound to the
   * exact confirmed bytes via a process-local live capability that is
   * re-verified before every canonical write. If arbitrary in-process
   * extensions are part of your threat model, treat any Core caller as already
   * trusted with user-level authority; the durable proof of "the user clicked
   * confirm" is the extension's receipt record, not this method.
   */
  recordPromotionApproval(
    plan: PromotionPlan,
    approvedBy: PromotionApprovalRecord['approved_by'],
  ): PromotionApprovalRecord {
    const cfg = readConfig(this.cwd)
    validatePromotionPlan(plan, this.cwd, cfg.project_id)
    if (
      !approvedBy ||
      approvedBy.kind !== 'human' ||
      approvedBy.channel !== 'pi-ui' ||
      typeof approvedBy.id !== 'string' ||
      !approvedBy.id.startsWith('pi-session://') ||
      approvedBy.id.trim() === ''
    )
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        'approval must be minted through the live Pi UI channel (channel=pi-ui, id=pi-session://...)',
      )
    // Never trust the plan's path bytes: re-derive the safe project-relative
    // target inside the validated boundary, then read exactly that file.
    const safeRel = assertProjectRelativePath(this.cwd, plan.target.path, 'promotion target')
    const current = tryReadText(path.join(this.cwd, safeRel))
    if (current === null || sha256hex(current) !== plan.before_sha256)
      throw new ProjectMemoryError('CONFLICT', 'canonical target changed before approval could be recorded', {
        target: plan.target.path,
        expected: plan.before_sha256,
        actual: current === null ? null : sha256hex(current),
      })
    const approvalRef = `pa_${crypto.randomBytes(16).toString('hex')}`
    const record: PromotionApprovalRecord = {
      schema_version: 1,
      approval_ref: approvalRef,
      project_id: cfg.project_id,
      note_id: plan.note_id,
      promotion_id: plan.promotion_id,
      target: plan.target,
      mode: plan.mode,
      payload_sha256: plan.payload_sha256,
      before_sha256: plan.before_sha256,
      after_sha256: plan.after_sha256,
      planned_at: plan.planned_at,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      status: 'approved',
      consumed_at: null,
    }
    writeJsonExclusive(approvalRecordPath(this.cwd, approvalRef), record)
    // Register the single-use capability in-process, bound to the EXACT approved
    // bytes. Only a live UI confirmation that reached this method can mint it;
    // a hand-crafted approval JSON on disk has no capability and cannot be
    // consumed, and editing this record afterwards breaks the binding.
    registerLiveApproval(approvalRef, {
      project_id: cfg.project_id,
      note_id: plan.note_id,
      promotion_id: plan.promotion_id,
      target: plan.target,
      mode: plan.mode,
      payload_sha256: plan.payload_sha256,
      before_sha256: plan.before_sha256,
      after_sha256: plan.after_sha256,
      planned_at: plan.planned_at,
      approved_at: record.approved_at,
      approved_by: record.approved_by.id,
    })
    return record
  }

  promote(id: string, opts: PromoteOptions): PromoteReceipt {
    if (!NOTE_ID_RE.test(id))
      throw new ProjectMemoryError('INVALID_INPUT', `note id must match ${NOTE_ID_RE}`, { id })
    if (!APPROVAL_REF_RE.test(opts.approval_ref ?? ''))
      throw new ProjectMemoryError('INVALID_INPUT', 'promote requires a valid content-bound approval_ref; booleans are not approval evidence')
    const cfg = readConfig(this.cwd)
    const initialApproval = readApprovalRecord(this.cwd, opts.approval_ref)
    if (!initialApproval)
      throw new ProjectMemoryError('INVALID_INPUT', `approval_ref ${opts.approval_ref} does not exist`)
    // The approval file on disk is NOT proof of approval: only a capability
    // minted in this process (after the user confirmed the exact bytes in the
    // live Pi UI) can authorize the canonical write, and it must still match
    // BOTH the disk record and this request field by field. Replayed
    // verifications of an already-promoted note may proceed without a live
    // capability because no canonical write happens on that path.
    const liveCapability = getLiveApproval(opts.approval_ref)
    const prepared = resolvePromotionTarget(this.cwd, opts)
    collectSecrets(cfg, { target: prepared.target, payload: prepared.payload }, '$promotion')
    assertApprovalBinding(initialApproval, cfg.project_id, id, opts, prepared)
    if (liveCapability) {
      assertLiveCapabilityMatchesApproval(liveCapability, initialApproval, cfg.project_id, id, opts, prepared)
    } else if (initialApproval.status !== 'consumed') {
      throw new ProjectMemoryError(
        'POLICY_VIOLATION',
        'approval_ref has no live capability in this process — re-confirm the exact target bytes through the Pi UI',
        { approval_ref: opts.approval_ref },
      )
    }

    const targetLock = promoteLockPath(this.cwd, prepared.rel)
    const targetFd = acquireLockFile(targetLock, {
      operation: 'promote',
      note_id: id,
      promotion_id: opts.promotion_id,
      target: prepared.rel,
      approval_ref: opts.approval_ref,
    })
    try {
      const approvalLock = approvalLockPath(this.cwd, opts.approval_ref)
      const approvalFd = acquireLockFile(
        approvalLock,
        { operation: 'consume-approval', approval_ref: opts.approval_ref },
        { waitMs: 15_000, retryMs: 5 },
      )
      try {
        const approval = readApprovalRecord(this.cwd, opts.approval_ref)
        if (!approval) throw new ProjectMemoryError('INCONSISTENT', 'approval record disappeared during promote')
        assertApprovalBinding(approval, cfg.project_id, id, opts, prepared)
        // Re-check the live capability against the record read under the lock:
        // the file could have been edited between the initial check and now.
        if (liveCapability)
          assertLiveCapabilityMatchesApproval(liveCapability, approval, cfg.project_id, id, opts, prepared)

        const noteLock = noteLockPath(this.cwd, id)
        const noteFd = acquireLockFile(
          noteLock,
          { operation: 'promote-note', note_id: id, approval_ref: opts.approval_ref },
          { waitMs: 15_000, retryMs: 5 },
        )
        try {
          const found = this.read(id)
          if (!found) throw new ProjectMemoryError('NOT_FOUND', `no trusted note with id ${id}`, { id })
          const current = tryReadText(prepared.abs)
          if (current === null) throw new ProjectMemoryError('CONFLICT', `canonical target disappeared: ${prepared.rel}`)
          const currentSha = sha256hex(current)

          if (found.note.promotion.status === 'promoted') {
            if (
              found.note.promotion.promotion_id !== opts.promotion_id ||
              found.note.promotion.target?.path !== prepared.rel ||
              currentSha !== approval.after_sha256 ||
              !backlinkExists(this.cwd, id, opts.promotion_id, prepared.rel, found.note.promotion.backlink)
            ) throw new ProjectMemoryError('CONFLICT', `note ${id} was promoted under different approved bytes`)
            if (approval.status === 'approved') consumeApprovalRecord(this.cwd, approval)
            return {
              status: 'replayed',
              id,
              promotion_id: opts.promotion_id,
              target: found.note.promotion.target,
              note: found.note,
              backlink: { mode: found.note.promotion.backlink!, targetPath: prepared.rel, verified: true },
              approval_ref: opts.approval_ref,
            }
          }
          if (approval.status !== 'approved')
            throw new ProjectMemoryError('CONFLICT', `approval_ref ${opts.approval_ref} has already been consumed`)
          if (found.note.promotion.status === 'promoting' && found.note.promotion.promotion_id !== opts.promotion_id)
            throw new ProjectMemoryError('CONFLICT', `another promotion is already in progress for ${id}`)
          if (isTerminal(found.note.type, found.note.status))
            throw new ProjectMemoryError('INVALID_INPUT', `cannot promote terminal note ${id} (status ${found.note.status})`)

          let afterContent: string
          if (currentSha === approval.before_sha256) {
            const marker = IN_FILE_MARKER_RE.exec(current)
            if (marker && !(marker[1] === id && marker[2] === opts.promotion_id))
              throw new ProjectMemoryError('CONFLICT', 'canonical target already carries another memory backlink')
            afterContent = buildCanonicalAfterContent(
              current,
              prepared,
              id,
              opts.promotion_id,
              approval.planned_at,
            )
            if (sha256hex(afterContent) !== approval.after_sha256)
              throw new ProjectMemoryError('CONFLICT', 'approved afterSha256 does not match the requested canonical bytes')
          } else if (currentSha === approval.after_sha256 && found.note.promotion.status === 'promoting') {
            afterContent = current
          } else {
            throw new ProjectMemoryError('CONFLICT', 'canonical target changed after approval; refusing to overwrite it', {
              target: prepared.rel,
              expectedBeforeSha256: approval.before_sha256,
              approvedAfterSha256: approval.after_sha256,
              actualSha256: currentSha,
            })
          }

          let promotingSha = found.sha256
          let promotingNote = found.note
          if (found.note.promotion.status !== 'promoting') {
            promotingNote = {
              ...structuredClone(found.note),
              promotion: {
                status: 'promoting',
                target: prepared.target,
                promotion_id: opts.promotion_id,
                promoted_at: null,
                backlink: null,
                backlink_verified: false,
              },
              updated_at: new Date().toISOString(),
            }
            promotingSha = writeNoteFileCas(found.file, found.sha256, promotingNote, found.body)
          }

          if (currentSha === approval.before_sha256) {
            writeCanonicalCas(prepared.abs, approval.before_sha256, afterContent, approval.after_sha256)
          }
          const promotedNote: Note = {
            ...promotingNote,
            status: 'promoted',
            promotion: {
              status: 'promoted',
              target: prepared.target,
              promotion_id: opts.promotion_id,
              promoted_at: approval.approved_at,
              backlink: 'in_file',
              backlink_verified: true,
            },
            updated_at: new Date().toISOString(),
          }
          const validation = validateNote(promotedNote)
          if (validation.length)
            throw new ProjectMemoryError('INTERNAL', `promote finalization failed schema: ${formatIssues(validation)}`, {
              issues: validation,
              id,
            })
          writeNoteFileCas(found.file, promotingSha, promotedNote, found.body)
          const reread = this.read(id)
          if (
            !reread ||
            reread.note.status !== 'promoted' ||
            reread.note.promotion.promotion_id !== opts.promotion_id ||
            sha256hex(tryReadText(prepared.abs) ?? '') !== approval.after_sha256
          ) throw new ProjectMemoryError('INTERNAL', `promote write-then-readback verification failed for ${id}`)
          consumeApprovalRecord(this.cwd, approval)
          this.rebuildIndex()
          return {
            status: 'promoted',
            id,
            promotion_id: opts.promotion_id,
            target: prepared.target,
            note: reread.note,
            backlink: { mode: 'in_file', targetPath: prepared.rel, verified: true },
            approval_ref: opts.approval_ref,
          }
        } finally {
          releaseLockFile(noteLock, noteFd)
        }
      } finally {
        releaseLockFile(approvalLock, approvalFd)
      }
    } finally {
      releaseLockFile(targetLock, targetFd)
    }
  }

  /* ---------------- durable pending capture ---------------- */

  redactForPersistence(text: string): string {
    return redactSecrets(text, secretRulesFor(readConfig(this.cwd)))
  }

  persistPendingCapture(envelope: PendingCaptureEnvelope): PendingCaptureEnvelope {
    const cfg = readConfig(this.cwd)
    validatePendingEnvelope(envelope, cfg.project_id)
    collectSecrets(cfg, envelope, '$pendingCapture')
    const lockPath = pendingLockPath(this.cwd)
    const lockFd = acquireLockFile(
      lockPath,
      { operation: 'persist-pending-capture', envelope_id: envelope.envelope_id },
      { waitMs: 15_000, retryMs: 5 },
    )
    try {
      const file = pendingEnvelopePath(this.cwd, envelope.envelope_id)
      const existing = tryReadJson<PendingCaptureEnvelope>(file)
      if (existing) {
        validatePendingEnvelope(existing, cfg.project_id)
        if (JSON.stringify(existing) !== JSON.stringify(envelope))
          throw new ProjectMemoryError('CONFLICT', `pending envelope ${envelope.envelope_id} already exists with different content`)
        return existing
      }
      writeJsonExclusive(file, envelope)
      return envelope
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  pendingCaptureEnvelopes(): PendingCaptureEnvelope[] {
    const cfg = readConfig(this.cwd)
    const dir = pendingDir(this.cwd)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    } catch {
      return []
    }
    return names.map((name) => {
      const file = path.join(dir, name)
      rejectSymlinkComponents(this.cwd, file, `pending/${name}`, 'INCONSISTENT')
      const envelope = tryReadJson<PendingCaptureEnvelope>(file)
      if (!envelope) throw new ProjectMemoryError('INCONSISTENT', `pending envelope is unparsable: ${name}`)
      validatePendingEnvelope(envelope, cfg.project_id)
      const secretHits = findSecretMatches(envelope, secretRulesFor(cfg), '$pendingCapture')
      if (secretHits.length)
        throw new ProjectMemoryError('INCONSISTENT', `pending envelope violates secret policy: ${name}`, {
          matched: secretHits.map((hit) => `${hit.rule}@${hit.path}`),
        })
      return envelope
    })
  }

  pendingCaptureCandidates(): PendingCaptureCandidate[] {
    return this.pendingCaptureEnvelopes()
      .flatMap((envelope) => envelope.candidates)
      .filter((candidate) => candidate.resolution === null)
  }

  resolvePendingCapture(
    candidateIds: string[],
    resolution: Omit<PendingCaptureResolution, 'resolved_at'>,
  ): PendingCaptureCandidate[] {
    const ids = [...new Set(candidateIds)]
    if (ids.length === 0 || ids.some((id) => !PENDING_CANDIDATE_ID_RE.test(id)))
      throw new ProjectMemoryError('INVALID_INPUT', 'candidate_ids must contain at least one valid pending candidate ID')
    if (!resolution.tool_call_id?.trim())
      throw new ProjectMemoryError('INVALID_INPUT', 'pending resolution requires the real tool_call_id')
    if (resolution.status === 'captured' && (!resolution.note_id || !NOTE_ID_RE.test(resolution.note_id)))
      throw new ProjectMemoryError('INVALID_INPUT', 'captured pending candidates require a valid note_id')
    if (resolution.status === 'skipped' && !resolution.reason?.trim())
      throw new ProjectMemoryError('INVALID_INPUT', 'skipped pending candidates require a concrete reason')

    const lockPath = pendingLockPath(this.cwd)
    const lockFd = acquireLockFile(
      lockPath,
      { operation: 'resolve-pending-capture', candidate_ids: ids },
      { waitMs: 15_000, retryMs: 5 },
    )
    try {
      // Phase 1 (read-only): validate the ENTIRE candidate set and compute all
      // mutations before writing anything. Any missing/conflicting ID aborts
      // with zero writes, so a mixed valid+invalid request cannot half-succeed.
      const envelopes = this.pendingCaptureEnvelopes()
      const found = new Set<string>()
      const mutations: Array<{ envelope: PendingCaptureEnvelope; file: string }> = []
      const resolved: PendingCaptureCandidate[] = []
      const at = new Date().toISOString()
      for (const envelope of envelopes) {
        let changed = false
        for (const candidate of envelope.candidates) {
          if (!ids.includes(candidate.candidate_id)) continue
          found.add(candidate.candidate_id)
          if (candidate.resolution !== null) {
            if (
              candidate.resolution.tool_call_id === resolution.tool_call_id &&
              candidate.resolution.status === resolution.status
            ) {
              resolved.push(candidate)
              continue
            }
            throw new ProjectMemoryError('CONFLICT', `candidate ${candidate.candidate_id} is already resolved`)
          }
          candidate.resolution = { ...resolution, resolved_at: at }
          changed = true
          resolved.push(candidate)
        }
        if (changed) mutations.push({ envelope, file: pendingEnvelopePath(this.cwd, envelope.envelope_id) })
      }
      const missing = ids.filter((id) => !found.has(id))
      if (missing.length) throw new ProjectMemoryError('NOT_FOUND', `pending candidates not found: ${missing.join(', ')}`)
      // Phase 2: commit all validated mutations. Each envelope is written to a
      // temporary file first; only after every temp write succeeds are they
      // renamed into place. A failure before the rename loop leaves the store
      // untouched, so a batch commit cannot half-apply resolutions.
      commitPendingMutations(
        mutations.map((mutation) => ({
          file: mutation.file,
          content: JSON.stringify(mutation.envelope, null, 2) + '\n',
        })),
      )
      return resolved
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  /* ---------------- index (§15.3) ---------------- */

  rebuildIndex(): { notes: number; triggers: number } {
    const cfg = readConfig(this.cwd)
    const hyd = this.scan().notes
    const { notes, triggers } = indexNoteEntries(
      this.cwd,
      hyd.map((h) => ({ noteObj: h.note as unknown as Record<string, unknown>, body: h.body, file: h.file, sha256: h.sha256 })),
    )
    writeIndexAtomic(this.cwd, notes, triggers, cfg.project_id)
    return { notes: notes.length, triggers: triggers.length }
  }

  /* ---------------- reconcile (§13) ---------------- */

  reconcile(opts: { fixIndex?: boolean } = {}): ReconcileReport {
    const fixIndex = opts.fixIndex ?? true
    const cfg = readConfig(this.cwd)
    const { notes: raws, errors: scanErrors } = scanNotes(this.cwd)
    const issues: ReconcileIssue[] = []
    const auto_fixed: string[] = []
    const notes: ScannedNote[] = []
    const byId = new Map<string, ScannedNote>()

    for (const err of scanErrors) {
      issues.push({ severity: 'error', code: 'PARSE', file: err.file, message: err.message })
    }
    const secretRules = secretRulesFor(cfg)
    for (const raw of raws) {
      const hyd = hydrateNote(raw)
      if (!hyd) {
        issues.push({
          severity: 'error',
          code: 'SCHEMA',
          file: raw.file,
          message: `note hydration failed${raw.noteObj.id ? ` (id=${raw.noteObj.id})` : ''}`,
        })
        continue
      }
      let validation: ValidationIssue[]
      try {
        validation = validateNote(hyd.note)
      } catch {
        validation = [{ message: 'validator rejected malformed structure' }]
      }
      for (const issue of validation) {
        issues.push({
          severity: 'error',
          code: 'SCHEMA',
          noteId: hyd.note.id || undefined,
          file: raw.file,
          message: `${issue.field ?? 'note'}: ${issue.message}`,
        })
      }
      if (validation.length > 0) continue
      if (hyd.note.project_id !== cfg.project_id) {
        issues.push({
          severity: 'error',
          code: 'PROJECT_ID_MISMATCH',
          noteId: hyd.note.id,
          file: raw.file,
          message: `note project_id ${hyd.note.project_id} does not match config project_id ${cfg.project_id}`,
        })
        continue
      }
      const secretHits = findSecretMatches({ note: raw.noteObj, body: raw.body }, secretRules, '$noteFile')
      if (secretHits.length > 0) {
        issues.push({
          severity: 'error',
          code: 'SECRET_POLICY',
          noteId: hyd.note.id,
          file: raw.file,
          message: `secret-bearing note quarantined at ${secretHits.map((hit) => `${hit.rule}@${hit.path}`).join(', ')}`,
        })
        continue
      }
      const base = path.basename(path.dirname(raw.file))
      const expected = TYPE_DIR[hyd.note.type]
      if (base !== expected) {
        issues.push({
          severity: 'warning',
          code: 'PLACEMENT',
          noteId: hyd.note.id,
          file: raw.file,
          message: `note file in ${base}/ but id type expects ${expected}/`,
        })
      }
      notes.push(hyd)
      byId.set(hyd.note.id, hyd)
    }

    // --- duplicate fingerprint among ACTIVE notes (invariant: no dup duties) ---
    const fpGroups = new Map<string, string[]>()
    for (const { note } of notes) {
      if (isTerminalNote(note)) continue
      const arr = fpGroups.get(note.fingerprint) ?? []
      arr.push(note.id)
      fpGroups.set(note.fingerprint, arr)
    }
    for (const [fp, ids] of fpGroups) {
      if (ids.length > 1)
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_FINGERPRINT',
          noteId: ids[0],
          message: `active notes share the exact fingerprint ${fp}: ${ids.join(', ')} (merge expected)`,
        })
    }

    // --- duplicate ids ---
    const idGroups = new Map<string, string[]>()
    for (const { note, file } of notes) {
      const arr = idGroups.get(note.id) ?? []
      arr.push(file)
      idGroups.set(note.id, arr)
    }
    for (const [id, files] of idGroups) {
      if (files.length > 1)
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_ID',
          noteId: id,
          message: `id ${id} defined in ${files.length} files: ${files.join(', ')}`,
        })
    }

    // --- supersedes cycle (invariant 6) ---
    const edges = new Map<string, string[]>(notes.map(({ note }) => [note.id, []]))
    const addSupersedesEdge = (newer: string, older: string) => {
      if (newer === older) return
      const outgoing = edges.get(newer) ?? []
      if (!outgoing.includes(older)) outgoing.push(older)
      edges.set(newer, outgoing)
    }
    for (const { note } of notes) {
      for (const older of note.relations.supersedes) addSupersedesEdge(note.id, older)
      // B.superseded_by=[A] normalizes to the same A -> B edge as A.supersedes=[B].
      for (const newer of note.relations.superseded_by) addSupersedesEdge(newer, note.id)
    }
    const cycle = findCycle(edges)
    if (cycle.length > 0)
      issues.push({
        severity: 'error',
        code: 'SUPERSEDES_CYCLE',
        message: `supersedes/superseded_by cycle: ${cycle.join(' -> ')}`,
      })

    // --- promote consistency (§12.4, invariants 7/8) ---
    for (const { note } of notes) {
      const pro = note.promotion
      if (pro.status === 'promoting') {
        issues.push({
          severity: 'error',
          code: 'HALF_DONE_PROMOTE',
          noteId: note.id,
          message: `promote left in progress (promotion_id="${pro.promotion_id}") — resume with the same promotion_id or review`,
        })
      }
      if (note.status === 'promoted') {
        if (pro.status !== 'promoted' || !pro.promotion_id)
          issues.push({
            severity: 'error',
            code: 'PROMOTED_WITHOUT_RECORD',
            noteId: note.id,
            message: `note is promoted but the promotion record is missing/incomplete`,
          })
      }
      if (pro.status === 'promoted') {
        const tgt = pro.target
        if (!tgt || !tgt.path)
          issues.push({ severity: 'error', code: 'PROMOTE_NO_TARGET', noteId: note.id, message: 'promoted note has no target path' })
        else {
          let targetRel = tgt.path
          try {
            targetRel = assertProjectRelativePath(this.cwd, tgt.path, 'promotion target')
            rejectSymlinkComponents(this.cwd, path.join(this.cwd, targetRel), 'promotion target', 'INCONSISTENT')
          } catch (error) {
            issues.push({
              severity: 'error',
              code: 'PROMOTE_TARGET_INVALID',
              noteId: note.id,
              message: `promoted target path invalid: ${error instanceof Error ? error.message : String(error)}`,
            })
            continue
          }
          const abs = path.join(this.cwd, targetRel)
          if (!fs.existsSync(abs)) {
            issues.push({
              severity: 'error',
              code: 'PROMOTE_TARGET_MISSING',
              noteId: note.id,
              message: `promoted target file missing: ${targetRel}`,
            })
          } else if (!fs.statSync(abs).isFile()) {
            issues.push({
              severity: 'error',
              code: 'PROMOTE_TARGET_INVALID',
              noteId: note.id,
              message: `promoted target is not a regular file: ${targetRel} (${fs.statSync(abs).isDirectory() ? 'directory' : 'non-regular'})`,
            })
          } else {
            const ok = backlinkExists(this.cwd, note.id, pro.promotion_id!, targetRel, pro.backlink)
            if (!ok)
              issues.push({
                severity: 'error',
                code: 'BACKLINK_MISSING',
                noteId: note.id,
                message: `promoted note lacks the canonical-side backlink (${pro.backlink ?? 'none'}) for ${targetRel}`,
              })
          }
        }
      }
    }
    // orphan backlink link-files (backlink exists but no matching promoted note)
    const promotedPairs = new Set(notes.filter((n) => n.note.status === 'promoted').map((n) => `${n.note.id}::${n.note.promotion.promotion_id}`))
    try {
      for (const rec of readBacklinks(this.cwd)) {
        if (!promotedPairs.has(`${rec.noteId}::${rec.promotion_id}`)) {
          issues.push({
            severity: 'warning',
            code: 'ORPHAN_BACKLINK',
            file: rec.file,
            message: `backlink for ${rec.noteId} (${rec.promotion_id}) has no matching promoted note — possible half-done promote`,
          })
        }
      }
    } catch (e) {
      if (e instanceof ProjectMemoryError && e.code === 'INCONSISTENT') {
        issues.push({ severity: 'error', code: 'BACKLINK_SYMLINK', message: `backlink scan rejected: ${e.message}` })
      } else throw e
    }

    // --- trigger sanity ---
    for (const { note } of notes) {
      if (!note.trigger) continue
      if (note.trigger.conditions.length === 0)
        issues.push({ severity: 'warning', code: 'TRIGGER_NO_CONDITIONS', noteId: note.id, message: 'trigger has no conditions' })
      for (const c of note.trigger.conditions) {
        if (c.kind === 'dependency' && !byId.has(c.key) && !/^PM-[A-Z-]+-\d{4,}$/.test(c.key)) {
          issues.push({
            severity: 'warning',
            code: 'TRIGGER_UNKNOWN_DEPENDENCY',
            noteId: note.id,
            message: `trigger references unknown dependency "${c.key}"`,
          })
        }
      }
    }

    // --- trusted canonical-conflict adapter output ---
    try {
      const canonicalState = this.loadCanonicalState()
      for (const [noteId, evidence] of Object.entries(canonicalState?.canonical_conflicts ?? {})) {
        const note = byId.get(noteId)
        if (!note) {
          issues.push({
            severity: 'warning',
            code: 'CANONICAL_CONFLICT_ORPHAN',
            noteId,
            message: `canonical conflict references a missing or quarantined note (${evidence.canonical_ref})`,
          })
          continue
        }
        if (evidence.note_sha256 && evidence.note_sha256 !== note.sha256) {
          issues.push({
            severity: 'warning',
            code: 'CANONICAL_CONFLICT_STALE',
            noteId,
            message: `canonical conflict evidence was produced for an older note revision (${evidence.canonical_ref})`,
          })
        } else {
          issues.push({
            severity: 'warning',
            code: 'CANONICAL_CONFLICT',
            noteId,
            message: `${evidence.reason} (canonical: ${evidence.canonical_ref}; effective review_status=needs_review)`,
          })
        }
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'CANONICAL_STATE_INVALID',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // --- durable pending capture and approval registries ---
    try {
      for (const envelope of this.pendingCaptureEnvelopes()) {
        const unresolved = envelope.candidates.filter((candidate) => candidate.resolution === null)
        if (unresolved.length > 0)
          issues.push({
            severity: 'warning',
            code: 'PENDING_CAPTURE',
            message: `${envelope.envelope_id} has unresolved candidates: ${unresolved.map((candidate) => candidate.candidate_id).join(', ')}`,
          })
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'PENDING_CAPTURE_INVALID',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      for (const approval of readApprovalRecords(this.cwd)) {
        validateApprovalRecord(approval, cfg.project_id)
        if (approval.status === 'approved')
          issues.push({
            severity: 'warning',
            code: 'UNCONSUMED_APPROVAL',
            noteId: approval.note_id,
            message: `approval ${approval.approval_ref} is still single-use pending for ${approval.target.path}`,
          })
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'APPROVAL_INVALID',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // --- stale transaction locks (crashed writers block their resource) ---
    let lockNames: string[] = []
    try {
      lockNames = fs
        .readdirSync(locksDir(this.cwd))
        .filter((f) => f.endsWith('.lock'))
        .sort()
    } catch {
      lockNames = []
    }
    for (const lf of lockNames) {
      const isPromote = lf.startsWith('promote-')
      issues.push({
        severity: 'warning',
        code: isPromote ? 'PROMOTE_LOCK_LEFTOVER' : 'TRANSACTION_LOCK_LEFTOVER',
        file: path.join(locksDir(this.cwd), lf),
        message: `${lf} exists — its owner may have crashed; the protected resource remains fail-closed until reviewed`,
      })
    }

    // --- index drift (auto-fixable) ---
    let snap: IndexSnapshot
    try {
      snap = readIndex(this.cwd)
    } catch (e) {
      if (e instanceof ProjectMemoryError && e.code === 'INCONSISTENT') {
        issues.push({ severity: 'error', code: 'INDEX_SYMLINK', message: `index rejected: ${e.message}` })
        snap = { notes: null, triggers: null } // treated as drift → rebuild replaces the link
      } else throw e
    }
    const existed = snap.notes !== null && snap.triggers !== null
    let drift = false
    if (snap.notes === null || snap.triggers === null) drift = true
    else if (snap.notes.project_id !== cfg.project_id || snap.triggers.project_id !== cfg.project_id) drift = true
    else {
      const expected = new Map(notes.map((n) => [n.note.id, n.sha256]))
      const cur = new Map(snap.notes!.notes.map((e) => [e.id, e.sha256]))
      if (expected.size !== cur.size) drift = true
      else for (const [id, sha] of expected) if (cur.get(id) !== sha) drift = true
    }
    if (drift) {
      if (fixIndex) {
        const { notes: n, triggers: tr } = this.rebuildIndex()
        auto_fixed.push(`index rebuilt (notes=${n}, triggers=${tr})`)
        issues.push({
          severity: 'warning',
          code: 'INDEX_DRIFT',
          message: 'index out of sync with raw notes — auto-rebuilt',
        })
      } else {
        issues.push({ severity: 'error', code: 'INDEX_DRIFT', message: 'index out of sync with raw notes (fixIndex=false)' })
      }
    }

    const { notes: n2, triggers: t2 } = readIndexStats(this.cwd)
    return {
      project_id: cfg.project_id,
      ran_at: new Date().toISOString(),
      notes_scanned: notes.length,
      issues,
      auto_fixed,
      index: { existed, rebuilt: auto_fixed.length > 0, notes_indexed: n2, triggers_indexed: t2 },
    }
  }
}

/* ================================================================== */
/* Internals                                                           */
/* ================================================================== */

const MEMORY_ROOT_NAME = '.project-memory'

function sourceKey(s: SourceRef): string {
  return [s.kind, s.ref, s.turn_id ?? ''].join('\u0000')
}

function formatIssues(issues: { field?: string; message: string }[]): string {
  return issues.map((i) => `${i.field ?? 'note'}: ${i.message}`).join('; ')
}

/**
 * Static path-shape guard for persisted promotion metadata. Rejects absolute
 * paths, `..` escapes, and anything inside .project-memory before any dynamic
 * (symlink/existence) check runs. The dynamic checks live in scan()/reconcile().
 */
function isUnsafeProjectRelativePath(relPath: string): boolean {
  if (path.isAbsolute(relPath)) return true
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) return true
  if (relPath === MEMORY_ROOT_NAME) return true
  if (relPath.startsWith(MEMORY_ROOT_NAME + '/')) return true
  return false
}

/** Coerce a raw parsed frontmatter object into a typed Note (best effort). */
function hydrateNote(raw: ScannedRaw): ScannedNote | null {
  const o = raw.noteObj as Partial<Note>
  if (typeof o.id !== 'string' || typeof o.type !== 'string') return null
  if (!NOTE_TYPES.includes(o.type as NoteType)) return null
  try {
    const note: Note = {
      schema_version: o.schema_version as number,
      id: o.id,
      project_id: typeof o.project_id === 'string' ? o.project_id : '',
      type: o.type as NoteType,
      status: typeof o.status === 'string' ? o.status : '',
      fingerprint: typeof o.fingerprint === 'string' ? o.fingerprint : '',
      title: typeof o.title === 'string' ? o.title : '',
      summary: typeof o.summary === 'string' ? o.summary : '',
      rationale: typeof o.rationale === 'string' ? o.rationale : '',
      priority: o.priority as Priority | undefined,
      authority: o.authority as Note['authority'],
      confidence: o.confidence as Confidence | undefined,
      sensitivity: o.sensitivity as Sensitivity | undefined,
      review_status: o.review_status === undefined ? 'clear' : (o.review_status as ReviewStatus),
      review_reason:
        o.review_reason === undefined
          ? null
          : (o.review_reason as Note['review_reason']),
      tags: o.tags as string[],
      source_refs: o.source_refs as SourceRef[],
      related_files: o.related_files as RelatedFile[],
      relations: o.relations as Relations,
      trigger: o.trigger as Trigger | null,
      no_trigger_reason: typeof o.no_trigger_reason === 'string' ? o.no_trigger_reason : null,
      next_action: typeof o.next_action === 'string' ? o.next_action : '',
      status_reason: typeof o.status_reason === 'string' ? o.status_reason : null,
      acceptance_evidence: typeof o.acceptance_evidence === 'string' ? o.acceptance_evidence : null,
      created_by: o.created_by as Note['created_by'],
      created_at: typeof o.created_at === 'string' ? o.created_at : '',
      updated_at: typeof o.updated_at === 'string' ? o.updated_at : '',
      promotion: o.promotion as Note['promotion'],
    }
    return { note, file: raw.file, body: raw.body, sha256: raw.sha256 }
  } catch {
    return null
  }
}

const PROMOTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const APPROVAL_REF_RE = /^pa_[0-9a-f]{32}$/
const PENDING_ENVELOPE_ID_RE = /^pc_[0-9a-f]{32}$/
const PENDING_CANDIDATE_ID_RE = /^cand_[0-9a-f]{32}$/

interface ResolvedPromotionTarget {
  target: CanonicalTarget
  abs: string
  rel: string
  isMarkdown: boolean
  mode: PromotionMode
  payload: string
}

function resolvePromotionTarget(cwd: string, request: PromotionRequest): ResolvedPromotionTarget {
  if (!PROMOTION_ID_RE.test(request.promotion_id ?? ''))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion_id has an invalid format')
  const requested = request.target
  if (!requested || typeof requested.path !== 'string' || requested.path.trim() === '')
    throw new ProjectMemoryError('INVALID_INPUT', 'promote requires an existing project-relative target path')
  const rel = assertProjectRelativePath(cwd, requested.path, 'canonical target')
  const abs = path.join(cwd, rel)
  rejectSymlinkComponents(cwd, abs, 'canonical target')
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
    throw new ProjectMemoryError('INVALID_INPUT', `canonical target must be an existing file: ${rel}`)
  const ext = path.extname(rel).toLowerCase()
  const isMarkdown = ext === '.md' || ext === '.markdown'
  const hasContent = request.content !== undefined
  const hasBlock = request.insertBlock !== undefined
  if (hasContent === hasBlock)
    throw new ProjectMemoryError('INVALID_INPUT', 'exactly one of content or insertBlock is required')
  if (hasContent && !isMarkdown && ext !== '.txt')
    throw new ProjectMemoryError('INVALID_INPUT', 'replace_file only supports .md/.markdown/.txt targets')
  if (hasBlock && !isMarkdown)
    throw new ProjectMemoryError('INVALID_INPUT', 'append_block only supports Markdown targets')
  const payload = hasContent ? request.content! : request.insertBlock!
  if (typeof payload !== 'string')
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion payload must be a string')
  if (IN_FILE_MARKER_RE.test(payload))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion payload must not forge a Project Memory backlink')
  const target: CanonicalTarget = {
    kind: (requested.kind ?? 'file') as CanonicalTargetKind,
    ref: requested.ref ?? rel,
    path: rel,
    objectId: requested.objectId,
    version: requested.version,
  }
  return { target, abs, rel, isMarkdown, mode: hasContent ? 'replace_file' : 'append_block', payload }
}

function buildCanonicalAfterContent(
  current: string,
  prepared: ResolvedPromotionTarget,
  noteId: string,
  promotionId: string,
  markerTimestamp: string,
): string {
  let base = prepared.mode === 'replace_file'
    ? prepared.payload
    : current.includes(prepared.payload)
      ? current
      : `${current.replace(/\s*$/, '')}\n\n${prepared.payload}\n`
  const markerMatch = IN_FILE_MARKER_RE.exec(base)
  if (markerMatch) {
    if (markerMatch[1] !== noteId || markerMatch[2] !== promotionId)
      throw new ProjectMemoryError('CONFLICT', 'canonical bytes carry a different backlink')
    return base
  }
  const marker = (prepared.isMarkdown ? inFileMarker : inFileMarkerLine)(
    noteId,
    promotionId,
    markerTimestamp,
  )
  base = `${base.replace(/\s*$/, '')}\n\n${marker}\n`
  return base
}

/**
 * Validate a promotion plan against the REAL project: the target path must be
 * a project-relative, non-symlink, existing file before any of its bytes can
 * be read or hashed. Without the cwd check, a forged plan could point outside
 * the project and recordPromotionApproval() would read it.
 */
function validatePromotionPlan(plan: PromotionPlan, cwd: string, projectId: string): void {
  if (!plan || plan.project_id !== projectId || !NOTE_ID_RE.test(plan.note_id))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan has the wrong project or Note identity')
  if (!PROMOTION_ID_RE.test(plan.promotion_id) || !isIso(plan.planned_at))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan has invalid transaction metadata')
  if (!['replace_file', 'append_block'].includes(plan.mode))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan has invalid mode')
  if (sha256hex(plan.payload_content) !== plan.payload_sha256)
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan payload hash mismatch')
  if (sha256hex(plan.before_content) !== plan.before_sha256 || sha256hex(plan.after_content) !== plan.after_sha256)
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan content hash mismatch')
  if (!/^[0-9a-f]{64}$/.test(plan.before_sha256) || !/^[0-9a-f]{64}$/.test(plan.after_sha256))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan hashes must be lowercase SHA-256')
  if (!plan.target || typeof plan.target !== 'object')
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan has no target')
  if (typeof plan.target.kind !== 'string' || plan.target.kind.trim() === '' || typeof plan.target.ref !== 'string' || plan.target.ref.trim() === '')
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan target kind/ref must be non-empty strings')
  if (typeof plan.target.path !== 'string' || isUnsafeProjectRelativePath(plan.target.path))
    throw new ProjectMemoryError('INVALID_INPUT', 'promotion plan target path must be project-relative and safe')
  const rel = assertProjectRelativePath(cwd, plan.target.path, 'promotion target')
  const abs = path.join(cwd, rel)
  rejectSymlinkComponents(cwd, abs, 'promotion target', 'INCONSISTENT')
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
    throw new ProjectMemoryError('INVALID_INPUT', `promotion target must be an existing file: ${rel}`)
}

function approvalRecordPath(cwd: string, approvalRef: string): string {
  if (!APPROVAL_REF_RE.test(approvalRef))
    throw new ProjectMemoryError('INVALID_INPUT', 'invalid approval_ref')
  return path.join(approvalsDir(cwd), `${approvalRef}.json`)
}

function writeJsonExclusive(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function tryReadJson<T>(file: string): T | null {
  const text = tryReadText(file)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function validateApprovalRecord(record: PromotionApprovalRecord, projectId: string): void {
  if (!record || record.schema_version !== 1 || !APPROVAL_REF_RE.test(record.approval_ref))
    throw new ProjectMemoryError('INCONSISTENT', 'malformed promotion approval record')
  if (record.project_id !== projectId || !NOTE_ID_RE.test(record.note_id) || !PROMOTION_ID_RE.test(record.promotion_id))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has invalid identity binding`)
  if (!record.target || typeof record.target !== 'object')
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has no target`)
  if (typeof record.target.path !== 'string' || record.target.path.trim() === '' || isUnsafeProjectRelativePath(record.target.path))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has an unsafe target path`)
  if (typeof record.target.kind !== 'string' || record.target.kind.trim() === '' || typeof record.target.ref !== 'string' || record.target.ref.trim() === '')
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has incomplete target kind/ref`)
  if (!['replace_file', 'append_block'].includes(record.mode))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has invalid mode`)
  for (const hash of [record.payload_sha256, record.before_sha256, record.after_sha256])
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has an invalid SHA-256 binding`)
  if (!isIso(record.planned_at) || !isIso(record.approved_at))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has invalid timestamps`)
  if (
    !record.approved_by ||
    record.approved_by.kind !== 'human' ||
    record.approved_by.channel !== 'pi-ui' ||
    typeof record.approved_by.id !== 'string' ||
    !record.approved_by.id.startsWith('pi-session://') ||
    record.approved_by.id.trim() === ''
  )
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} lacks a live-Pi-UI-principal`)
  if (!['approved', 'consumed'].includes(record.status))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} has invalid status`)
  if (record.status === 'approved' && record.consumed_at !== null)
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} is approved but already timestamped consumed`)
  if (record.status === 'consumed' && (!record.consumed_at || !isIso(record.consumed_at)))
    throw new ProjectMemoryError('INCONSISTENT', `approval ${record.approval_ref} lacks consumed_at`)
}

/* ------------------------------------------------------------------ */
/* Process-local approval capability registry                          */
/* ------------------------------------------------------------------ */

interface LiveCapability {
  project_id: string
  note_id: string
  promotion_id: string
  target: CanonicalTarget
  mode: PromotionMode
  payload_sha256: string
  before_sha256: string
  after_sha256: string
  planned_at: string
  approved_at: string
  approved_by: string
}

/**
 * Approval files on disk are data, not credentials: a hand-written JSON under
 * .project-memory/approvals/ proves nothing. Only a capability minted in THIS
 * process by recordPromotionApproval() (which itself requires a live Pi UI
 * confirmation) can authorize the canonical mutation. The registry is
 * process-local; a restarted session must re-confirm before promoting.
 *
 * The capability captures the EXACT approved content (note/promotion ids,
 * full target, mode and before/after/payload hashes). promote() compares the
 * capability against both the on-disk approval record and the live request;
 * if either was altered after confirmation, the write is refused — being
 * approved once does not carry over to different bytes.
 */
const liveApprovalCapabilities = new Map<string, LiveCapability>()

function registerLiveApproval(approvalRef: string, capability: LiveCapability): void {
  liveApprovalCapabilities.set(approvalRef, capability)
}

function getLiveApproval(approvalRef: string): LiveCapability | null {
  return liveApprovalCapabilities.get(approvalRef) ?? null
}

function unregisterLiveApproval(approvalRef: string): void {
  liveApprovalCapabilities.delete(approvalRef)
}

/**
 * Verify the capability is bound to the EXACT bytes the user confirmed.
 * Called before every canonical write: a capability only marks "this process
 * approved this exact plan", so the on-disk record and the incoming request
 * must both still match it field by field. This closes the approve-A-then-
 * edit-B race: rewriting the approval file to content B produces a mismatch
 * against the capability (which still holds A), and promote refuses.
 */
function assertLiveCapabilityMatchesApproval(
  capability: LiveCapability,
  approval: PromotionApprovalRecord,
  projectId: string,
  noteId: string,
  request: PromotionRequest,
  prepared: ResolvedPromotionTarget,
): void {
  const mismatches: string[] = []
  if (capability.project_id !== projectId) mismatches.push('cap.project_id')
  if (capability.note_id !== noteId) mismatches.push('cap.note_id')
  if (capability.promotion_id !== request.promotion_id) mismatches.push('cap.promotion_id')
  if (capability.target.kind !== prepared.target.kind || capability.target.ref !== prepared.target.ref || capability.target.path !== prepared.rel)
    mismatches.push('cap.target')
  if (capability.mode !== prepared.mode) mismatches.push('cap.mode')
  if (capability.payload_sha256 !== sha256hex(prepared.payload)) mismatches.push('cap.payload_sha256')
  if (capability.before_sha256 !== approval.before_sha256) mismatches.push('cap.before_sha256')
  if (capability.after_sha256 !== approval.after_sha256) mismatches.push('cap.after_sha256')
  if (capability.payload_sha256 !== approval.payload_sha256) mismatches.push('cap.payload_sha256_vs_approval')
  if (capability.target.path !== approval.target.path) mismatches.push('cap.target_vs_approval')
  if (capability.target.kind !== approval.target.kind) mismatches.push('cap.target_kind_vs_approval')
  if (capability.mode !== approval.mode) mismatches.push('cap.mode_vs_approval')
  if (capability.note_id !== approval.note_id) mismatches.push('cap.note_vs_approval')
  if (capability.promotion_id !== approval.promotion_id) mismatches.push('cap.promotion_vs_approval')
  if (capability.planned_at !== approval.planned_at) mismatches.push('cap.planned_at')
  if (capability.approved_at !== approval.approved_at) mismatches.push('cap.approved_at')
  if (capability.approved_by !== approval.approved_by.id) mismatches.push('cap.approved_by')
  if (mismatches.length)
    throw new ProjectMemoryError(
      'POLICY_VIOLATION',
      `approved content no longer matches the live capability (${mismatches.join(', ')}) — re-confirm through the Pi UI`,
      { approval_ref: approval.approval_ref, mismatches },
    )
}

function readApprovalRecord(cwd: string, approvalRef: string): PromotionApprovalRecord | null {
  const cfg = readConfig(cwd)
  const file = approvalRecordPath(cwd, approvalRef)
  rejectSymlinkComponents(cwd, file, `approvals/${approvalRef}.json`, 'INCONSISTENT')
  const record = tryReadJson<PromotionApprovalRecord>(file)
  if (record) validateApprovalRecord(record, cfg.project_id)
  return record
}

function readApprovalRecords(cwd: string): PromotionApprovalRecord[] {
  let names: string[] = []
  try {
    names = fs.readdirSync(approvalsDir(cwd)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
  return names.map((name) => {
    const ref = name.slice(0, -5)
    const record = readApprovalRecord(cwd, ref)
    if (!record) throw new ProjectMemoryError('INCONSISTENT', `approval record is unparsable: ${name}`)
    return record
  })
}

function assertApprovalBinding(
  approval: PromotionApprovalRecord,
  projectId: string,
  noteId: string,
  request: PromotionRequest,
  prepared: ResolvedPromotionTarget,
): void {
  validateApprovalRecord(approval, projectId)
  const mismatches: string[] = []
  if (approval.note_id !== noteId) mismatches.push('note_id')
  if (approval.promotion_id !== request.promotion_id) mismatches.push('promotion_id')
  if (approval.target.path !== prepared.rel) mismatches.push('target.path')
  if (approval.target.kind !== prepared.target.kind) mismatches.push('target.kind')
  if (approval.mode !== prepared.mode) mismatches.push('mode')
  if (approval.payload_sha256 !== sha256hex(prepared.payload)) mismatches.push('payload_sha256')
  if (mismatches.length)
    throw new ProjectMemoryError('CONFLICT', `approval_ref is not bound to this promotion (${mismatches.join(', ')})`, {
      approval_ref: approval.approval_ref,
      mismatches,
    })
}

function consumeApprovalRecord(cwd: string, approval: PromotionApprovalRecord): void {
  const file = approvalRecordPath(cwd, approval.approval_ref)
  const current = readApprovalRecord(cwd, approval.approval_ref)
  if (!current) throw new ProjectMemoryError('INCONSISTENT', 'approval disappeared before consumption')
  if (current.status === 'consumed') return
  writeFileAtomic(file, JSON.stringify({
    ...current,
    status: 'consumed',
    consumed_at: new Date().toISOString(),
  }, null, 2) + '\n')
  const reread = readApprovalRecord(cwd, approval.approval_ref)
  if (!reread || reread.status !== 'consumed')
    throw new ProjectMemoryError('INTERNAL', `approval consumption readback failed: ${approval.approval_ref}`)
  unregisterLiveApproval(approval.approval_ref)
}

function writeCanonicalCas(
  file: string,
  expectedBeforeSha256: string,
  afterContent: string,
  expectedAfterSha256: string,
): void {
  const current = tryReadText(file)
  const actual = current === null ? null : sha256hex(current)
  if (actual !== expectedBeforeSha256)
    throw new ProjectMemoryError('CONFLICT', 'canonical target changed immediately before CAS write', {
      file,
      expectedBeforeSha256,
      actualSha256: actual,
    })
  if (sha256hex(afterContent) !== expectedAfterSha256)
    throw new ProjectMemoryError('INTERNAL', 'canonical CAS was given bytes that do not match afterSha256')
  writeFileAtomic(file, afterContent)
  const reread = tryReadText(file)
  if (reread === null || sha256hex(reread) !== expectedAfterSha256)
    throw new ProjectMemoryError('INTERNAL', `canonical CAS readback failed: ${file}`)
}

/** Thin service-layer wrapper so resolvePendingCapture reads as a single commit step. */
function commitPendingMutations(files: Array<{ file: string; content: string }>): void {
  writeFileAtomicBatch(files)
}

function pendingEnvelopePath(cwd: string, envelopeId: string): string {
  if (!PENDING_ENVELOPE_ID_RE.test(envelopeId))
    throw new ProjectMemoryError('INVALID_INPUT', 'invalid pending envelope_id')
  return path.join(pendingDir(cwd), `${envelopeId}.json`)
}

function validatePendingEnvelope(envelope: PendingCaptureEnvelope, projectId: string): void {
  if (!envelope || envelope.schema_version !== 1 || !PENDING_ENVELOPE_ID_RE.test(envelope.envelope_id))
    throw new ProjectMemoryError('INCONSISTENT', 'malformed pending-capture envelope')
  if (envelope.project_id !== projectId || !envelope.session_id || !envelope.source_leaf_id || !isIso(envelope.created_at))
    throw new ProjectMemoryError('INCONSISTENT', `pending envelope ${envelope.envelope_id} has invalid provenance`)
  if (!Array.isArray(envelope.candidates) || envelope.candidates.length === 0)
    throw new ProjectMemoryError('INCONSISTENT', `pending envelope ${envelope.envelope_id} has no candidates`)
  const seen = new Set<string>()
  for (const candidate of envelope.candidates) {
    if (!candidate || !PENDING_CANDIDATE_ID_RE.test(candidate.candidate_id) || seen.has(candidate.candidate_id))
      throw new ProjectMemoryError('INCONSISTENT', `pending envelope ${envelope.envelope_id} has invalid candidate IDs`)
    seen.add(candidate.candidate_id)
    if (!NOTE_TYPES.includes(candidate.type) || !Array.isArray(candidate.markers) || candidate.markers.length === 0)
      throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} has invalid type/markers`)
    if (!candidate.source_ref || !SOURCE_REF_KINDS.includes(candidate.source_ref.kind) || !candidate.source_ref.ref)
      throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} has invalid source_ref`)
    if (typeof candidate.source_excerpt !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.source_excerpt_sha256))
      throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} has invalid excerpt evidence`)
    if (!isIso(candidate.detected_at))
      throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} has invalid detected_at`)
    if (candidate.resolution !== null) {
      const resolution = candidate.resolution
      if (!['captured', 'skipped'].includes(resolution.status) || !isIso(resolution.resolved_at) || !resolution.tool_call_id)
        throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} has invalid resolution`)
      if (resolution.status === 'captured' && (!resolution.note_id || !NOTE_ID_RE.test(resolution.note_id)))
        throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} captured without a valid note_id`)
      if (resolution.status === 'skipped' && !resolution.reason)
        throw new ProjectMemoryError('INCONSISTENT', `candidate ${candidate.candidate_id} skipped without reason`)
    }
  }
}

const TASK_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'task', 'start', 'please',
  '一个', '这个', '那个', '这些', '那些', '进行', '开始', '处理', '项目',
])

function lexicalTerms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const raw = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_.:-]*/gu) ?? []
  const terms = new Set<string>()
  for (const token of raw) {
    if (TASK_STOP_WORDS.has(token)) continue
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token].filter((char) => /\p{Script=Han}/u.test(char))
      if (chars.length <= 2) terms.add(chars.join(''))
      else for (let index = 0; index < chars.length - 1; index++) terms.add(chars.slice(index, index + 2).join(''))
    } else if (token.length >= 2) {
      terms.add(token)
    }
  }
  return [...terms].slice(0, 32)
}

function scoreTaskRelevance(hit: SearchHit, terms: string[]): { score: number; terms: string[] } {
  const fields: Array<[string, number]> = [
    [hit.note.title, 8],
    [hit.note.summary, 6],
    [hit.note.next_action, 4],
    [hit.note.tags.join(' '), 4],
    [hit.note.related_files.map((item) => `${item.path} ${item.relation}`).join(' '), 4],
    [hit.note.rationale, 2],
    [hit.body, 1],
  ]
  let score = 0
  const matched = new Set<string>()
  for (const term of terms) {
    for (const [field, weight] of fields) {
      if (field.normalize('NFKC').toLowerCase().includes(term)) {
        score += weight
        matched.add(term)
        break
      }
    }
  }
  return { score, terms: [...matched] }
}

function backlinkExists(cwd: string, id: string, promotionId: string, rel: string, mode: BacklinkMode | null): boolean {
  if (mode === 'in_file') {
    const content = tryReadText(path.join(cwd, rel))
    if (content === null) return false
    const m = IN_FILE_MARKER_RE.exec(content)
    return !!m && m[1] === id && m[2] === promotionId
  }
  if (mode === 'link_file') {
    try {
      const rec = parseBacklinkFileThatExists(linkFileFor(cwd, rel))
      return !!rec && rec.noteId === id && rec.promotion_id === promotionId
    } catch {
      return false // symlink backlink record → never trust it
    }
  }
  return false
}

function findCycle(edges: Map<string, string[]>): string[] {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  for (const id of edges.keys()) color.set(id, WHITE)

  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of edges.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) {
        const i = stack.indexOf(next)
        return stack.slice(i).concat(next)
      }
      if (c === WHITE) {
        const r = dfs(next)
        if (r) return r
      }
    }
    stack.pop()
    color.set(id, BLACK)
    return null
  }
  for (const id of edges.keys()) {
    if (color.get(id) === WHITE) {
      const r = dfs(id)
      if (r) return r
    }
  }
  return []
}

function readIndexStats(cwd: string): { notes: number; triggers: number } {
  let snap: IndexSnapshot
  try {
    snap = readIndex(cwd)
  } catch {
    snap = { notes: null, triggers: null }
  }
  return {
    notes: snap.notes?.notes.length ?? 0,
    triggers: snap.triggers?.triggers.length ?? 0,
  }
}


/* ================================================================== */
/* Standalone API (extension/tests friendly)                           */
/* ================================================================== */

export function initProject(cwd: string, opts: InitProjectOptions): { config: ConfigFile; created: boolean } {
  return new ProjectMemory(cwd).init(opts)
}

export function openProject(cwd: string): ProjectMemory {
  return new ProjectMemory(cwd)
}

export function capture(cwd: string, input: CaptureInput): CaptureReceipt {
  return new ProjectMemory(cwd).capture(input)
}

export function read(cwd: string, id: string): ScannedNote | null {
  return new ProjectMemory(cwd).read(id)
}

export function search(cwd: string, query?: SearchQuery): SearchHit[] {
  return new ProjectMemory(cwd).search(query)
}

export function update(cwd: string, id: string, patch: UpdatePatch): ScannedNote {
  return new ProjectMemory(cwd).update(id, patch)
}

export function close(cwd: string, id: string, opts: CloseOptions): ScannedNote {
  return new ProjectMemory(cwd).close(id, opts)
}

export function planPromotion(cwd: string, id: string, request: PromotionRequest): PromotionPlan {
  return new ProjectMemory(cwd).planPromotion(id, request)
}

export function recordPromotionApproval(
  cwd: string,
  plan: PromotionPlan,
  approvedBy: PromotionApprovalRecord['approved_by'],
): PromotionApprovalRecord {
  return new ProjectMemory(cwd).recordPromotionApproval(plan, approvedBy)
}

export function promote(cwd: string, id: string, opts: PromoteOptions): PromoteReceipt {
  return new ProjectMemory(cwd).promote(id, opts)
}

export function evaluateTriggers(
  cwd: string,
  state?: TriggerState,
  opts?: { includeNotDue?: boolean },
): TriggerEvaluation {
  return new ProjectMemory(cwd).evaluateTriggers(state, opts)
}

export function taskStartRetrieval(
  cwd: string,
  opts?: { state?: TriggerState; types?: NoteType[]; text?: string; limit?: number },
): { due: TriggerResult[]; active: SearchHit[] } {
  return new ProjectMemory(cwd).taskStartRetrieval(opts)
}

export function reconcile(cwd: string, opts?: { fixIndex?: boolean }): ReconcileReport {
  return new ProjectMemory(cwd).reconcile(opts)
}

export function rebuildIndex(cwd: string): { notes: number; triggers: number } {
  return new ProjectMemory(cwd).rebuildIndex()
}