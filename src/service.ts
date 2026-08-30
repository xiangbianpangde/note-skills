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
 *   - basic secret scanning with fail-closed rejection (§9.7, §4.11)
 *   - lazy milestone/dependency trigger evaluation (§11.6–§11.8)
 *   - controlled promote: approved=true, existing canonical target,
 *     promotion_id idempotency, write-then-readback, bidirectional links (§12)
 *   - reconcile: schema/duplicate/cycle/half-done-promote/index-drift checks,
 *     index auto-repair only (§13)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
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
  SourceRef,
  RelatedFile,
  Relations,
  Trigger,
  TriggerCondition,
  TriggerState,
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
  writeFileAtomic,
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
  promoteLockPath,
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
    if (r.re.test(text)) hits.push(r.name)
  }
  return hits
}

function collectSecrets(cfg: ConfigFile, fields: Iterable<[string, unknown]>): void {
  const rules = secretRulesFor(cfg)
  const hits: string[] = []
  for (const [name, value] of fields) {
    if (typeof value !== 'string' || value === '') continue
    for (const r of rules) if (r.re.test(value)) hits.push(`${r.name}@${name}`)
  }
  if (hits.length) {
    throw new ProjectMemoryError('POLICY_VIOLATION', `capture rejected by secret policy`, {
      matched: hits,
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
  const idOk = typeof note.id === 'string' && (note.id === '' || NOTE_ID_RE.test(note.id))
  if (!idOk)
    bad('id', idRequired ? `must match ${NOTE_ID_RE}` : `must match ${NOTE_ID_RE} or be empty before allocation`)
  if (typeof note.type !== 'string' || !NOTE_TYPES.includes(note.type as NoteType))
    bad('type', `must be one of ${NOTE_TYPES.join(', ')}`)
  if (typeof note.type === 'string' && NOTE_TYPES.includes(note.type as NoteType)) {
    const type = note.type as NoteType
    if (!isLegalStatus(type, note.status)) bad('status', `illegal status "${note.status}" for type ${type}`)
    // 'promoted' is only reachable through promote() (which sets the promotion
    // record in the same write); the inverse is checked below.
    if (note.status === 'promoted' && note.promotion.status !== 'promoted')
      bad('status', 'status "promoted" requires the promotion record (promote() must be used)')
    if (note.promotion.status === 'promoted' && note.status !== 'promoted')
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

  if (!Array.isArray(note.source_refs) || note.source_refs.length === 0)
    bad('source_refs', 'at least one source_ref is required (invariant 3)')
  else
    note.source_refs.forEach((s, i) => {
      if (!SOURCE_REF_KINDS.includes(s.kind)) bad(`source_refs[${i}].kind`, `unknown kind ${s.kind}`)
      if (typeof s.ref !== 'string' || s.ref === '') bad(`source_refs[${i}].ref`, 'must be non-empty')
    })

  if (typeof note.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(note.fingerprint))
    bad('fingerprint', 'must be "sha256:<64 hex>"')

  for (const t of note.tags ?? []) {
    if (typeof t !== 'string' || t.trim() === '') bad('tags', 'each tag must be a non-empty string')
  }
  for (const rf of note.related_files ?? []) {
    if (typeof rf?.path !== 'string' || rf.path === '') bad('related_files', 'each entry needs path')
  }
  const relMap = (k: string, v: string[]) => {
    if (!Array.isArray(v)) bad('relations', `${k} must be an array`)
    for (const x of v) {
      if (typeof x !== 'string' || x === '') bad('relations', `${k} entries must be non-empty strings`)
      if (k === 'supersedes' && x === note.id) bad('relations.supersedes', 'note cannot supersede itself')
    }
  }
  relMap('depends_on', note.relations?.depends_on ?? [])
  relMap('related_to', note.relations?.related_to ?? [])
  relMap('supersedes', note.relations?.supersedes ?? [])
  relMap('superseded_by', note.relations?.superseded_by ?? [])
  relMap('derived_from', note.relations?.derived_from ?? [])
  relMap('promoted_to', note.relations?.promoted_to ?? [])

  if (note.trigger !== null) {
    const tr = note.trigger
    if (typeof tr !== 'object' || !Array.isArray(tr.conditions) || tr.conditions.length === 0)
      bad('trigger', 'conditions must be a non-empty array')
    else if (tr.mode !== undefined && tr.mode !== 'all' && tr.mode !== 'any')
      bad('trigger.mode', `must be "all" or "any"`)
    tr.conditions.forEach((c, i) => {
      const p = `trigger.conditions[${i}]`
      if (c.kind === 'milestone') {
        if (typeof c.key !== 'string' || c.key === '') bad(p + '.key', 'must be non-empty')
        const op = c.operator ?? 'equals'
        if (!['equals', 'not_equals', 'in'].includes(op)) bad(p + '.operator', `unknown operator ${op}`)
        if (op === 'in' && !Array.isArray(c.value)) bad(p + '.value', 'operator "in" requires string[]')
        if (op !== 'in' && typeof c.value !== 'string') bad(p + '.value', 'requires a string value')
      } else if (c.kind === 'dependency') {
        if (typeof c.key !== 'string' || c.key === '') bad(p + '.key', 'must be non-empty')
        const op = c.operator ?? 'status_in'
        if (!['status_in', 'status_equals'].includes(op)) bad(p + '.operator', `unknown operator ${op}`)
        if (op === 'status_in' && !Array.isArray(c.value) && typeof c.value !== 'string')
          bad(p + '.value', 'requires string[] or string')
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
  if (!note.created_by || typeof note.created_by.kind !== 'string' || typeof note.created_by.id !== 'string')
    bad('created_by', 'must be { kind, id }')

  const pro = note.promotion
  if (!pro || !['not_promoted', 'promoting', 'promoted'].includes(pro.status))
    bad('promotion.status', `illegal promotion status`)
  if (pro.status === 'not_promoted') {
    if (pro.target !== null) bad('promotion.target', 'must be null while not_promoted')
    if (pro.promotion_id !== null) bad('promotion.promotion_id', 'must be null while not_promoted')
    if (pro.promoted_at !== null) bad('promotion.promoted_at', 'must be null while not_promoted')
  } else {
    if (!pro.target) bad('promotion.target', 'required once promoting/promoted')
    if (typeof pro.promotion_id !== 'string' || pro.promotion_id === '')
      bad('promotion.promotion_id', 'required once promoting/promoted (invariant 7)')
    if (pro.status === 'promoted') {
      if (pro.backlink === null) bad('promotion.backlink', 'required when promoted (invariant 8)')
      if (!pro.backlink_verified) bad('promotion.backlink_verified', 'must be true when promoted')
      if (pro.promoted_at === null) bad('promotion.promoted_at', 'required when promoted')
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
  /** Present when state was supplied and the note has a trigger. */
  triggerEval?: TriggerResult
}

export interface PromoteOptions {
  /** MUST be exactly true — promotes are never model self-approvals (§9.2, §12.3). */
  approved: boolean
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

export interface PromoteReceipt {
  status: 'promoted' | 'replayed'
  id: string
  promotion_id: string
  target: CanonicalTarget
  note: Note
  backlink: { mode: BacklinkMode; targetPath: string; verified: boolean }
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

    // --- deterministic input validation ---
    if (!NOTE_TYPES.includes(input.type))
      throw new ProjectMemoryError('INVALID_INPUT', `unknown type "${input.type}"`)
    for (const f of ['title', 'summary', 'rationale', 'next_action'] as const) {
      if (typeof input[f] !== 'string' || input[f].trim() === '')
        throw new ProjectMemoryError('INVALID_INPUT', `${f} must be a non-empty string`)
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

    // --- secret policy (fail closed) ---
    collectSecrets(cfg, [
      ['title', input.title],
      ['summary', input.summary],
      ['rationale', input.rationale],
      ['next_action', input.next_action],
      ['body', input.body ?? ''],
      ['status_reason', input.status_reason ?? ''],
      ['no_trigger_reason', input.no_trigger_reason ?? ''],
      ['acceptance_evidence', input.acceptance_evidence ?? ''],
      ['tags', (input.tags ?? []).join(' ')],
      ['source_refs', input.source_refs.map((s) => s.ref + (s.turn_id ?? '')).join(' ')],
    ])

    const now = new Date().toISOString()
    const fingerprint = fingerprintOf(input.type, input.title, input.summary)

    // --- exact-fingerprint dedup against ACTIVE notes (§10.6) ---
    const { notes: raws } = scanNotes(this.cwd)
    for (const raw of raws) {
      const existing = hydrateNote(raw)
      if (!existing) continue
      if (
        existing.note.fingerprint === fingerprint &&
        existing.note.type === input.type &&
        !isTerminalNote(existing.note)
      ) {
        return this.mergeInto(raw, existing, input, fingerprint, now)
      }
    }

    // --- fresh note ---
    const note: Note = {
      schema_version: SCHEMA_VERSION,
      id: '', // allocated by storage (exclusive create)
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
    // Pre-allocation: id is empty (exclusive create allocates it) — run schema
    // validation with idRequired=false; full validation runs after allocation.
    const preIssues = validateNote(note, { idRequired: false })
    if (preIssues.length)
      throw new ProjectMemoryError('INVALID_INPUT', `capture rejected by schema: ${formatIssues(preIssues)}`, {
        issues: preIssues,
      })

    const { id, file } = createNoteFileExclusive(this.cwd, note, input.body ?? '')
    const finalNote = { ...note, id }
    const postIssues = validateNote(finalNote)
    if (postIssues.length)
      throw new ProjectMemoryError(
        'INTERNAL',
        `capture post-allocation validation failed: ${formatIssues(postIssues)}`,
        { issues: postIssues, id },
      )
    this.rebuildIndex()
    return { status: 'created', id, fingerprint, file, note: finalNote }
  }

  private mergeInto(
    raw: ScannedRaw,
    existing: ScannedNote,
    input: CaptureInput,
    fingerprint: string,
    now: string,
  ): CaptureReceipt {
    const note = existing.note
    const added: SourceRef[] = []
    const have = new Set(note.source_refs.map(sourceKey))
    for (const s of input.source_refs) {
      if (!have.has(sourceKey(s))) {
        note.source_refs.push(s)
        added.push(s)
      }
    }
    for (const t of input.tags ?? []) if (!note.tags.includes(t)) note.tags.push(t)
    for (const rf of input.related_files ?? [])
      if (!note.related_files.some((x) => x.path === rf.path)) note.related_files.push(rf)
    // relations: append-only union
    const rel = note.relations
    const mergeRel = (key: keyof Relations, vals?: string[]) => {
      for (const v of vals ?? []) if (!rel[key].includes(v)) rel[key].push(v)
    }
    mergeRel('depends_on', input.relations?.depends_on)
    mergeRel('related_to', input.relations?.related_to)
    mergeRel('supersedes', input.relations?.supersedes)
    mergeRel('superseded_by', input.relations?.superseded_by)
    mergeRel('derived_from', input.relations?.derived_from)
    mergeRel('promoted_to', input.relations?.promoted_to)
    if (note.trigger === null && input.trigger !== undefined && input.trigger !== null) {
      note.trigger = input.trigger
    }
    if (note.next_action === '' && input.next_action) note.next_action = input.next_action
    note.updated_at = now
    note.fingerprint = fingerprint
    // Never overwrite existing rationale (§10.6: append new info only).
    const issues = validateNote(note)
    if (issues.length)
      throw new ProjectMemoryError('INVALID_INPUT', `merge rejected by schema: ${formatIssues(issues)}`, {
        issues,
        mergedInto: note.id,
      })
    writeNoteFile(raw.file, note, raw.body)
    this.rebuildIndex()
    return {
      status: 'merged',
      id: note.id,
      fingerprint,
      file: raw.file,
      note,
      added_sources: added,
    }
  }

  /* ---------------- read / search ---------------- */

  /** Whole-store scan with hydration; parse errors and duplicates collected. */
  scan(): { notes: ScannedNote[]; errors: ScanIssue[]; duplicates: string[] } {
    const { notes: raws, errors } = scanNotes(this.cwd)
    const notes: ScannedNote[] = []
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const raw of raws) {
      const hyd = hydrateNote(raw)
      if (!hyd) {
        errors.push({ file: raw.file, message: 'note failed schema validation (see reconcile)' })
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

    for (const { note: n, file, body } of notes) {
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
      hits.push({ note: n, file, body, textMatched, triggerEval })
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
    const cfg = readConfig(this.cwd)
    const found = this.read(id)
    if (!found) throw new ProjectMemoryError('NOT_FOUND', `no note with id ${id}`, { id })

    const forbidden = ['id', 'project_id', 'type', 'schema_version', 'source_refs', 'created_at', 'created_by', 'promotion', 'fingerprint'] as const
    for (const k of forbidden) {
      if (k in patch)
        throw new ProjectMemoryError('INVALID_INPUT', `field "${k}" is immutable via update`)
    }

    const note = found.note
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
    if (patch.next_action !== undefined) note.next_action = patch.next_action.trim()
    if ('trigger' in patch) note.trigger = patch.trigger ?? null
    if ('no_trigger_reason' in patch) note.no_trigger_reason = patch.no_trigger_reason ?? null
    if ('acceptance_evidence' in patch) note.acceptance_evidence = patch.acceptance_evidence ?? null
    if (patch.related_files !== undefined) note.related_files = patch.related_files
    if (patch.relations !== undefined) {
      for (const k of Object.keys(patch.relations) as (keyof Relations)[]) {
        note.relations[k] = patch.relations[k] ?? []
      }
    }

    // Recompute the exact dedup fingerprint when identity fields changed.
    const fp = fingerprintOf(note.type, note.title, note.summary)
    if (fp !== note.fingerprint) note.fingerprint = fp

    // Secret policy on new content (fail closed).
    collectSecrets(cfg, [
      ['title', note.title],
      ['summary', note.summary],
      ['rationale', note.rationale],
      ['next_action', note.next_action],
      ['body', patch.body ?? ''],
      ['status_reason', note.status_reason ?? ''],
      ['acceptance_evidence', note.acceptance_evidence ?? ''],
      ['no_trigger_reason', note.no_trigger_reason ?? ''],
      ['tags', note.tags.join(' ')],
    ])

    const issues = validateNote(note)
    if (issues.length)
      throw new ProjectMemoryError('INVALID_INPUT', `update rejected by schema: ${formatIssues(issues)}`, {
        issues,
        id,
      })
    note.updated_at = new Date().toISOString()
    const finalBody = patch.body !== undefined ? patch.body : found.body
    writeNoteFile(found.file, note, finalBody)
    this.rebuildIndex()
    return { note, file: found.file, body: finalBody, sha256: sha256hex(tryReadText(found.file) ?? '') }
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
    const state: TriggerState = { milestones }
    if (Object.keys(noteStatuses).length > 0) state.noteStatuses = noteStatuses
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
    for (const { note: n } of notes) {
      if (!n.trigger || isTerminalNote(n)) continue
      const r = this.evaluateTrigger(n, state, statusLookup, state.noteStatuses)
      if (r.state === 'due') due.push(r)
      else if (r.state === 'unresolved') unresolved.push(r)
      else if (opts.includeNotDue) not_due.push(r)
    }
    return { due, unresolved, not_due }
  }

  /** Working set for OnTaskStart: due triggers + bounded active memory. */
  taskStartRetrieval(opts: { state?: TriggerState; types?: NoteType[]; limit?: number } = {}): {
    due: TriggerResult[]
    active: SearchHit[]
  } {
    const state = opts.state ?? this.loadCanonicalState()
    const due = state ? this.evaluateTriggers(state).due : []
    const active = this.search({ includeTerminal: false, limit: 100 }).filter((h) =>
      opts.types ? opts.types!.includes(h.note.type) : true,
    )
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

  promote(id: string, opts: PromoteOptions): PromoteReceipt {
    if (opts.approved !== true)
      throw new ProjectMemoryError('INVALID_INPUT', 'promote requires approved=true (explicit approval evidence)', {
        id,
      })
    if (typeof opts.promotion_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(opts.promotion_id))
      throw new ProjectMemoryError('INVALID_INPUT', 'promotion_id must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', {
        promotion_id: opts.promotion_id,
      })

    // Canonical target must already exist and live inside the project (§12.4).
    const t = opts.target
    if (!t || typeof t.path !== 'string' || t.path === '')
      throw new ProjectMemoryError('INVALID_INPUT', 'promote requires an existing canonical target path')
    const abs = path.isAbsolute(t.path) ? t.path : path.join(this.cwd, t.path)
    const rel = relPath(this.cwd, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw new ProjectMemoryError('INVALID_INPUT', `canonical target escapes the project: ${t.path}`)
    if (rel.startsWith(MEMORY_ROOT_NAME + '/') || rel === MEMORY_ROOT_NAME)
      throw new ProjectMemoryError('INVALID_INPUT', 'cannot promote into the memory root (.project-memory)')
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
      throw new ProjectMemoryError('INVALID_INPUT', `canonical target must be an existing file: ${t.path}`, {
        path: rel,
      })
    // Symlink fail-closed: no component of the target (itself included) may be
    // a symlink, and realpath must remain inside the project.
    rejectSymlinkComponents(this.cwd, abs, 'canonical target')

    // Canonical mutation is mandatory and text-only (§12.3 step 6): exactly one
    // of `content` (exact file content) / `insertBlock` (exact markdown block).
    const ext = path.extname(rel).toLowerCase()
    const isMarkdownTarget = ext === '.md' || ext === '.markdown'
    if (opts.content !== undefined && !isMarkdownTarget && ext !== '.txt')
      throw new ProjectMemoryError('INVALID_INPUT', `promote content writes only support text targets (.md/.markdown/.txt), got ${JSON.stringify(ext || '(none)')}`)
    if (opts.insertBlock !== undefined && !isMarkdownTarget)
      throw new ProjectMemoryError('INVALID_INPUT', 'promote insertBlock only supports Markdown targets (.md/.markdown)')
    if (opts.content === undefined && opts.insertBlock === undefined)
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        'promote requires content (exact file content) or insertBlock (exact markdown block) — the canonical mutation is mandatory (§12.3)',
        { id },
      )

    // Cross-process transaction lock for this canonical target (§12.3):
    // TWO concurrent promotes of DIFFERENT notes into the SAME target must
    // serialize — the marker precheck alone is racy (both can pass it before
    // either writes). The lock is acquired BEFORE any note/target write and
    // released in a finally. A concurrent holder gets an immediate CONFLICT.
    const lockPath = promoteLockPath(this.cwd, rel)
    const lockFd = acquireLockFile(lockPath, {
      note_id: id,
      promotion_id: opts.promotion_id,
      target: rel,
    })
    try {
      const found = this.read(id)
      if (!found) throw new ProjectMemoryError('NOT_FOUND', `no note with id ${id}`, { id })
      const note = found.note
      const target: CanonicalTarget = {
        kind: (t.kind ?? 'file') as CanonicalTargetKind,
        ref: t.ref ?? rel,
        path: rel,
        objectId: t.objectId,
        version: t.version,
      }

      // Idempotent replay: already promoted with the same promotion_id + target.
      if (note.promotion.status === 'promoted') {
        if (note.promotion.promotion_id !== opts.promotion_id)
          throw new ProjectMemoryError(
            'CONFLICT',
            `note ${id} already promoted with promotion_id "${note.promotion.promotion_id}"`,
            { id, existing: note.promotion.promotion_id },
          )
        if (note.promotion.target?.path !== rel)
          throw new ProjectMemoryError('CONFLICT', `note ${id} already promoted to a different target`, {
            id,
            existing: note.promotion.target?.path,
            requested: rel,
          })
        const existingMode = note.promotion.backlink
        if (!backlinkExists(this.cwd, id, opts.promotion_id, rel, existingMode))
          throw new ProjectMemoryError(
            'INCONSISTENT',
            `promoted note ${id} is missing its canonical backlink — run reconcile or resume the promotion`,
            { id, promotion_id: opts.promotion_id },
          )
        return {
          status: 'replayed',
          id,
          promotion_id: opts.promotion_id,
          target: note.promotion.target,
          note,
          backlink: { mode: existingMode!, targetPath: rel, verified: true },
        }
      }
      if (note.promotion.status === 'promoting') {
        if (note.promotion.promotion_id !== opts.promotion_id)
          throw new ProjectMemoryError(
            'CONFLICT',
            `promote already in progress for ${id} with promotion_id "${note.promotion.promotion_id}" — resume with that id`,
            { id, inProgress: note.promotion.promotion_id },
          )
        // resume: fall through, backlink step is idempotent
      }
      if (isTerminal(note.type, note.status))
        throw new ProjectMemoryError('INVALID_INPUT', `cannot promote terminal note ${id} (status ${note.status})`, {
          id,
        })

    // Pre-mutation backlink guard (§4.10, §12.4): a canonical target that
    // already carries a Project Memory marker may only be reused by the SAME
    // (noteId, promotion_id) — otherwise the marker belongs to someone else
    // and any write (content mutation OR marker) would hijack it. This check
    // is read-only and runs BEFORE every write (Phase 1 note write included),
    // so a CONFLICT can never change the target or the note.
    const existingMarker = IN_FILE_MARKER_RE.exec(tryReadText(abs) ?? '')
    if (existingMarker && !(existingMarker[1] === id && existingMarker[2] === opts.promotion_id)) {
      throw new ProjectMemoryError('CONFLICT', 'canonical target already carries a memory backlink', {
        target: rel,
        existingNote: existingMarker[1],
        existingPromotion: existingMarker[2],
        requestedNote: id,
        requestedPromotion: opts.promotion_id,
      })
    }

    // Phase 1: mark the transaction in progress (durable crash marker).
    const promotingNote: Note = {
      ...note,
      promotion: {
        status: 'promoting',
        target,
        promotion_id: opts.promotion_id,
        promoted_at: null,
        backlink: null,
        backlink_verified: false,
      },
      updated_at: new Date().toISOString(),
    }
    writeNoteFile(found.file, promotingNote, found.body)

    // Phase 2: canonical mutation (idempotent, §12.3 step 6) then write the
    // canonical-side backlink (step 9). Both are write-then-readback.
    applyCanonicalMutation(this.cwd, rel, opts)
    const mode = ensurePromoteBacklink.call(this, id, opts.promotion_id, target)

    // Phase 3: finalize + readback (§12.3 steps 6–8).
    const promotedNote: Note = {
      ...promotingNote,
      status: 'promoted',
      promotion: {
        status: 'promoted',
        target,
        promotion_id: opts.promotion_id,
        promoted_at: new Date().toISOString(),
        backlink: mode,
        backlink_verified: true,
      },
    }
    // validation before write
    const issues = validateNote(promotedNote)
    if (issues.length)
      throw new ProjectMemoryError('INTERNAL', `promote finalization failed schema: ${formatIssues(issues)}`, {
        issues,
        id,
      })
    writeNoteFile(found.file, promotedNote, found.body)

    // Read back: re-parse the written file and verify every critical field.
    const reread = this.read(id)
    if (
      !reread ||
      reread.note.status !== 'promoted' ||
      reread.note.promotion.status !== 'promoted' ||
      reread.note.promotion.promotion_id !== opts.promotion_id ||
      reread.note.promotion.target?.path !== rel
    ) {
      throw new ProjectMemoryError(
        'INTERNAL',
        `promote write-then-readback verification failed for ${id} — note is left marked promoting; retry with the same promotion_id or run reconcile`,
        { id, promotion_id: opts.promotion_id },
      )
    }
    this.rebuildIndex()
      return {
        status: 'promoted',
        id,
        promotion_id: opts.promotion_id,
        target,
        note: reread.note,
        backlink: { mode, targetPath: rel, verified: true },
      }
    } finally {
      releaseLockFile(lockPath, lockFd)
    }
  }

  /* ---------------- index (§15.3) ---------------- */

  rebuildIndex(): { notes: number; triggers: number } {
    const cfg = readConfig(this.cwd)
    const { notes: raws } = scanNotes(this.cwd)
    const hyd = raws.map((r) => hydrateNote(r)).filter((h): h is ScannedNote => !!h)
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
    for (const raw of raws) {
      const hyd = hydrateNote(raw)
      if (!hyd) {
        issues.push({
          severity: 'error',
          code: 'SCHEMA',
          file: raw.file,
          message: `note failed schema validation${raw.noteObj.id ? ` (id=${raw.noteObj.id})` : ''}`,
        })
        continue
      }
      const v = validateNote(hyd.note)
      for (const vi of v) {
        issues.push({
          severity: 'error',
          code: 'SCHEMA',
          noteId: hyd.note.id,
          file: raw.file,
          message: `${vi.field ?? 'note'}: ${vi.message}`,
        })
      }
      // file placement check (derived from id prefix)
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
    const edges = new Map<string, string[]>()
    for (const { note } of notes) {
      const list = edges.get(note.id) ?? []
      for (const s of note.relations.supersedes) if (s !== note.id) list.push(s)
      for (const s of note.relations.superseded_by) if (s !== note.id) list.push(s)
      edges.set(note.id, list)
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
          const abs = path.join(this.cwd, tgt.path)
          if (!fs.existsSync(abs)) {
            issues.push({
              severity: 'error',
              code: 'PROMOTE_TARGET_MISSING',
              noteId: note.id,
              message: `promoted target file missing: ${tgt.path}`,
            })
          } else {
            const ok = backlinkExists(this.cwd, note.id, pro.promotion_id!, tgt.path, pro.backlink)
            if (!ok)
              issues.push({
                severity: 'error',
                code: 'BACKLINK_MISSING',
                noteId: note.id,
                message: `promoted note lacks the canonical-side backlink (${pro.backlink ?? 'none'}) for ${tgt.path}`,
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

    // --- stale promote transaction locks (crashed promote blocks its target) ---
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
      issues.push({
        severity: 'warning',
        code: 'PROMOTE_LOCK_LEFTOVER',
        file: path.join(locksDir(this.cwd), lf),
        message:
          'promote transaction lock file exists — the owning promote may have crashed; promotes to this canonical target are blocked until the lock is removed',
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

/** Coerce a raw parsed frontmatter object into a typed Note (best effort). */
function hydrateNote(raw: ScannedRaw): ScannedNote | null {
  const o = raw.noteObj as Partial<Note>
  if (typeof o.id !== 'string' || typeof o.type !== 'string') return null
  if (!NOTE_TYPES.includes(o.type as NoteType)) return null
  try {
    const note: Note = {
      schema_version: typeof o.schema_version === 'number' ? o.schema_version : SCHEMA_VERSION,
      id: o.id,
      project_id: typeof o.project_id === 'string' ? o.project_id : '',
      type: o.type as NoteType,
      status: typeof o.status === 'string' ? o.status : '',
      fingerprint: typeof o.fingerprint === 'string' ? o.fingerprint : '',
      title: typeof o.title === 'string' ? o.title : '',
      summary: typeof o.summary === 'string' ? o.summary : '',
      rationale: typeof o.rationale === 'string' ? o.rationale : '',
      priority: o.priority as Priority | undefined,
      authority: (o.authority as Note['authority']) ?? 'memory',
      confidence: o.confidence as Confidence | undefined,
      sensitivity: o.sensitivity as Sensitivity | undefined,
      tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
      source_refs: Array.isArray(o.source_refs) ? (o.source_refs as SourceRef[]) : [],
      related_files: Array.isArray(o.related_files) ? (o.related_files as RelatedFile[]) : [],
      relations: { ...emptyRelations(), ...(o.relations ?? {}) },
      trigger: (o.trigger as Trigger | null) ?? null,
      no_trigger_reason: typeof o.no_trigger_reason === 'string' ? o.no_trigger_reason : null,
      next_action: typeof o.next_action === 'string' ? o.next_action : '',
      status_reason: typeof o.status_reason === 'string' ? o.status_reason : null,
      acceptance_evidence: typeof o.acceptance_evidence === 'string' ? o.acceptance_evidence : null,
      created_by: (o.created_by as Note['created_by']) ?? { kind: 'tool', id: 'unknown' },
      created_at: typeof o.created_at === 'string' ? o.created_at : '',
      updated_at: typeof o.updated_at === 'string' ? o.updated_at : '',
      promotion: o.promotion ?? defaultPromotionInfo(),
    }
    return { note, file: raw.file, body: raw.body, sha256: raw.sha256 }
  } catch {
    return null
  }
}

/**
 * Idempotent canonical mutation (§12.3 step 6): either set the exact file
 * content (`content`) or append an exact Markdown block (`insertBlock`); a
 * write only happens when the target does not already match, and every write
 * is followed by a readback.
 */
function applyCanonicalMutation(cwd: string, rel: string, opts: PromoteOptions): void {
  const abs = path.join(cwd, rel)
  if (opts.content !== undefined) {
    const current = tryReadText(abs)
    if (current !== opts.content) {
      writeFileAtomic(abs, opts.content)
      const after = tryReadText(abs)
      if (after !== opts.content)
        throw new ProjectMemoryError('INTERNAL', `canonical content write-then-readback failed for ${rel}`)
    }
    return
  }
  const block = opts.insertBlock!
  const current = tryReadText(abs)
  if (current === null)
    throw new ProjectMemoryError('INTERNAL', `unexpectedly cannot re-read canonical target ${rel}`)
  if (!current.includes(block)) {
    writeFileAtomic(abs, current.replace(/\s*$/, '') + '\n\n' + block + '\n')
    const after = tryReadText(abs) ?? ''
    if (!after.includes(block))
      throw new ProjectMemoryError('INTERNAL', `block write-then-readback failed for ${rel}`)
  }
}

function ensurePromoteBacklink(
  this: ProjectMemory,
  id: string,
  promotionId: string,
  target: CanonicalTarget,
): BacklinkMode {
  const abs = path.join(this.cwd, target.path)
  const ext = path.extname(target.path).toLowerCase()
  const isMarkdown = ext === '.md' || ext === '.markdown'
  const content = tryReadText(abs) ?? ''

  const m = IN_FILE_MARKER_RE.exec(content)
  if (m) {
    if (m[1] === id && m[2] === promotionId) return 'in_file'
    throw new ProjectMemoryError('CONFLICT', `canonical target already carries a memory backlink`, {
      target: target.path,
      existingNote: m[1],
      existingPromotion: m[2],
      requestedNote: id,
      requestedPromotion: promotionId,
    })
  }
  const marker = (isMarkdown ? inFileMarker : inFileMarkerLine)(id, promotionId, new Date().toISOString())
  writeFileAtomic(abs, content.replace(/\s*$/, '') + '\n\n' + marker + '\n')
  // readback of the canonical-side write
  const after = tryReadText(abs) ?? ''
  if (!after.includes(`promotion_id: ${promotionId}`)) {
    throw new ProjectMemoryError('INTERNAL', `backlink write-then-readback failed for ${abs}`)
  }
  return 'in_file'
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
  opts?: { state?: TriggerState; types?: NoteType[]; limit?: number },
): { due: TriggerResult[]; active: SearchHit[] } {
  return new ProjectMemory(cwd).taskStartRetrieval(opts)
}

export function reconcile(cwd: string, opts?: { fixIndex?: boolean }): ReconcileReport {
  return new ProjectMemory(cwd).reconcile(opts)
}

export function rebuildIndex(cwd: string): { notes: number; triggers: number } {
  return new ProjectMemory(cwd).rebuildIndex()
}