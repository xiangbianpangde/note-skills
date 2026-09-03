/**
 * storage.ts — filesystem layer for Note Skills.
 *
 * Responsibilities (all deterministic, no AI dependency):
 *   - .note-skills/ layout: config.yaml, notes/<type-dir>/, index/, backlinks/
 *   - Markdown + YAML frontmatter parsing/serialization
 *   - Stable ID allocation via exclusive create (O_EXCL / 'wx') so concurrent
 *     captures can never collide on an ID
 *   - Atomic file writes (tmp + fsync + rename)
 *   - Derived index read/write (notes.json, triggers.json) + backlink records
 *
 * The index is a derived artifact: it is never required for correctness and is
 * fully rebuildable from the raw notes (§4.1, §15.3, invariant 9).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as yaml from 'yaml'

import {
  TYPE_ABBR,
  isTerminal,
  ProjectMemoryError,
  CHECKPOINT_ID_RE,
  PROJECT_CONTEXT_FILENAME,
  PROJECT_CONTEXT_MAX_BYTES,
} from './model.ts'
import type {
  ErrorCode,
  Note,
  NoteType,
  Trigger,
  TriggerCondition,
  ProjectContextMetadata,
  ProjectContext,
  FlushReceipt,
  FlushInput,
} from './model.ts'

/* ------------------------------------------------------------------ */
/* Layout (§15.3)                                                      */
/* ------------------------------------------------------------------ */

export const MEMORY_ROOT = '.note-skills'
export const CONFIG_FILE = 'config.yaml'
export const NOTES_DIR = 'notes'
export const INDEX_DIR = 'index'
export const BACKLINKS_DIR = 'backlinks'
export const LOCKS_DIR = 'locks'
export const APPROVALS_DIR = 'approvals'
export const PENDING_DIR = 'pending'
export const CHECKPOINTS_DIR = 'checkpoints'

export const TYPE_DIR: Record<NoteType, string> = {
  deferred_work: 'deferred',
  decision: 'decisions',
  open_question: 'questions',
  assumption: 'assumptions',
  risk: 'risks',
  idea: 'ideas',
}

export const TYPE_DIRS: readonly string[] = Object.values(TYPE_DIR)

export function memoryRoot(cwd: string): string {
  return path.join(cwd, MEMORY_ROOT)
}
export function configPath(cwd: string): string {
  return path.join(memoryRoot(cwd), CONFIG_FILE)
}
export function notesRoot(cwd: string): string {
  return path.join(memoryRoot(cwd), NOTES_DIR)
}
export function typeDir(cwd: string, type: NoteType): string {
  return path.join(notesRoot(cwd), TYPE_DIR[type])
}
export function indexDir(cwd: string): string {
  return path.join(memoryRoot(cwd), INDEX_DIR)
}
export function backlinksDir(cwd: string): string {
  return path.join(memoryRoot(cwd), BACKLINKS_DIR)
}

export function locksDir(cwd: string): string {
  return path.join(memoryRoot(cwd), LOCKS_DIR)
}

export function approvalsDir(cwd: string): string {
  return path.join(memoryRoot(cwd), APPROVALS_DIR)
}

export function checkpointsDir(cwd: string): string {
  return path.join(memoryRoot(cwd), CHECKPOINTS_DIR)
}

export function projectContextPath(cwd: string): string {
  return path.join(cwd, PROJECT_CONTEXT_FILENAME)
}

export function checkpointPath(cwd: string, checkpointId: string): string {
  return path.join(checkpointsDir(cwd), `${checkpointId}.md`)
}

export function flushReceiptPath(cwd: string, checkpointId: string): string {
  return path.join(checkpointsDir(cwd), `${checkpointId}.receipt.json`)
}

export function contextLockPath(cwd: string): string {
  return path.join(locksDir(cwd), 'context.lock')
}

export function pendingDir(cwd: string): string {
  return path.join(memoryRoot(cwd), PENDING_DIR)
}

export function assertProjectDir(cwd: string): void {
  if (!fs.existsSync(cwd)) {
    throw new ProjectMemoryError('INVALID_INPUT', `project cwd does not exist: ${cwd}`)
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new ProjectMemoryError('INVALID_INPUT', `project cwd is not a directory: ${cwd}`)
  }
}

/**
 * Reject any EXISTING path component (from cwd down, final included) that is a
 * symlink, and verify that the file's realpath stays inside the project. A
 * missing final path is allowed (about to be created). `code` selects the
 * error class: 'INVALID_INPUT' for caller-supplied paths (promote target),
 * 'INCONSISTENT' for config-provided paths (canonical_state_file).
 * Symlink components above cwd are intentionally not inspected (the project
 * dir itself may legitimately live under a /tmp → /private/tmp style link).
 */
export function rejectSymlinkComponents(
  cwd: string,
  absPath: string,
  label: string,
  code: ErrorCode = 'INVALID_INPUT',
): void {
  const rel = path.relative(cwd, absPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ProjectMemoryError(code, `${label} is outside the project: ${absPath}`, { [label]: absPath })
  }
  let cur = cwd
  for (const comp of rel.split(path.sep)) {
    if (!comp) continue
    cur = path.join(cur, comp)
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(cur)
    } catch {
      st = null // missing component — fine (about to be created)
    }
    if (st && st.isSymbolicLink()) {
      throw new ProjectMemoryError(code, `${label} must not contain symlinks (component: ${cur})`, {
        [label]: absPath,
        symlinkComponent: cur,
      })
    }
  }
  // Belt-and-braces: even without symlinks in the walk, realpath must stay in cwd.
  try {
    const real = fs.realpathSync(absPath)
    const realCwd = fs.realpathSync(cwd)
    const back = path.relative(realCwd, real)
    if (back.startsWith('..') || path.isAbsolute(back)) {
      throw new ProjectMemoryError(code, `${label} resolves outside the project (realpath: ${real})`, {
        [label]: absPath,
        realpath: real,
      })
    }
  } catch (e) {
    if (e instanceof ProjectMemoryError) throw e
    // file does not exist yet — nothing to resolve
  }
}

/**
 * Fail-closed guard for the whole .note-skills tree: the memory root, its
 * fixed subdirectories (notes, index, backlinks, the six type dirs) must never
 * be symlinks — otherwise config/note/index writes could land outside the
 * project, or reads could reach outside content. Missing components (not yet
 * created) are fine. Called before every memory-root write AND read.
 */
export function assertMemoryRootSafe(cwd: string): void {
  const targets: Array<[string, string]> = [
    [memoryRoot(cwd), '.note-skills'],
    [notesRoot(cwd), '.note-skills/notes'],
    [indexDir(cwd), '.note-skills/index'],
    [backlinksDir(cwd), '.note-skills/backlinks'],
    [locksDir(cwd), '.note-skills/locks'],
    [approvalsDir(cwd), '.note-skills/approvals'],
    [pendingDir(cwd), '.note-skills/pending'],
    [checkpointsDir(cwd), '.note-skills/checkpoints'],
    ...TYPE_DIRS.map((d) => [path.join(notesRoot(cwd), d), `.note-skills/notes/${d}`] as [string, string]),
  ]
  for (const [abs, label] of targets) {
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(abs)
    } catch {
      st = null
    }
    if (!st) continue
    if (st.isSymbolicLink()) {
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        `${label} must not be a symlink (memory root must not escape the project)`,
        { path: abs },
      )
    }
  }
}

/**
 * Heuristic: is this a real v0.3.x memory root (not just a directory that
 * happens to be named .project-memory)? Only treat it as legacy when it
 * carries the old store's markers: a config.yaml, a notes/ tree, or a
 * pending/ directory. Failing to detect is safe (fresh store); a false
 * positive would only warn on a directory the user likely wants gone anyway.
 */
function isValidLegacyRoot(dir: string): boolean {
  for (const marker of ['config.yaml', 'notes', 'pending', 'index', 'backlinks']) {
    if (fs.existsSync(path.join(dir, marker))) return true
  }
  return false
}

/** Create the full .note-skills tree (idempotent). */
export function ensureMemoryDirs(cwd: string): void {
  assertMemoryRootSafe(cwd)
  fs.mkdirSync(notesRoot(cwd), { recursive: true })
  for (const d of TYPE_DIRS) fs.mkdirSync(path.join(notesRoot(cwd), d), { recursive: true })
  fs.mkdirSync(indexDir(cwd), { recursive: true })
  fs.mkdirSync(backlinksDir(cwd), { recursive: true })
  fs.mkdirSync(locksDir(cwd), { recursive: true })
  fs.mkdirSync(approvalsDir(cwd), { recursive: true })
  fs.mkdirSync(pendingDir(cwd), { recursive: true })
  fs.mkdirSync(checkpointsDir(cwd), { recursive: true })
}

/* ------------------------------------------------------------------ */
/* config.yaml                                                         */
/* ------------------------------------------------------------------ */

export interface ConfigFile {
  schema_version: number
  /** REQUIRED: identifies the project owning the memory (invariant 1, §8.4). */
  project_id: string
  created_at: string
  /** Extra regex sources appended to the built-in secret rules. */
  extra_secret_patterns?: string[]
  /**
   * Optional project-relative path to the canonical state file (milestone
   * statuses etc.) that lazy Trigger evaluation reads. Must live inside the
   * project, outside .note-skills. When unset (or the file is absent),
   * triggers are NOT evaluated — never guessed, and never self-triggered from
   * notes or from state inside .note-skills (§11.7–§11.8).
   */
  canonical_state_file?: string
  /**
   * Retrieval injection gate (opt-in): when "first_ask", the first
   * before_agent_start retrieval asks the model/user to start (via a
   * displayed prompt decision), when "enabled" retrieval always injects,
   * when "disabled" it never injects. Default first_ask (opt-in, not
   * automatic — field report: broad queries previously polluted context
   * before the user ever asked for memory).
   */
  retrieval_gate?: 'first_ask' | 'enabled' | 'disabled'
}

export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Fail-closed guard for custom secret regexes: invalid patterns, nested
 * quantifiers (ReDoS) or pathological length must never silently disable a
 * rule the project relies on. Throws INCONSISTENT at config load/init.
 */
export function assertSafeSecretPattern(src: string, label: string): void {
  if (typeof src !== 'string' || src.trim() === '')
    throw new ProjectMemoryError('INCONSISTENT', `${label} must be a non-empty string`)
  if (src.length > 512)
    throw new ProjectMemoryError('INCONSISTENT', `${label} exceeds 512 chars`)
  try {
    new RegExp(src)
  } catch {
    throw new ProjectMemoryError('INCONSISTENT', `${label} is not a valid regular expression`)
  }
  // Classic ReDoS constructions we reject (without trying to be a complete
  // regex-safety oracle):
  //   1. nested quantifiers: (a+)+, (a?){2,}, (.*)*, [a-z]+{2}
  //   2. quantified alternation overlap: (a|aa)+$, (ab|a)+ — ambiguous
  //      alternation under a quantifier is a well-known catastrophic shape.
  const hasNestedQuantifier =
    new RegExp(
      '(?:[+*?]|\\{\\d+(?:,\\d*)?\\})\\s*[)\\] ]?\\s*(?:[+*?]|\\{\\d+(?:,\\d*)?\\})',
    ).test(src)
  const hasQuantifiedAlternation = /\([^()]*\|[^()]*\)\s*[+*?]/.test(src)
  if (hasNestedQuantifier || hasQuantifiedAlternation)
    throw new ProjectMemoryError('INCONSISTENT', `${label} contains high-risk quantifier patterns (ReDoS risk)`)
}

export function readConfig(cwd: string): ConfigFile {
  assertProjectDir(cwd)
  assertMemoryRootSafe(cwd)
  const file = configPath(cwd)
  // The config file itself must never be a symlink (would read/write outside).
  rejectSymlinkComponents(cwd, file, 'config.yaml')
  let cfg: unknown
  try {
    cfg = yaml.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    cfg = null
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ProjectMemoryError(
      'MISSING_CONFIG',
      `missing or unparsable ${path.relative(cwd, file)} — run initProject first`,
      { file },
    )
  }
  const c = cfg as Record<string, unknown>
  if (typeof c.project_id !== 'string' || c.project_id.trim() === '') {
    throw new ProjectMemoryError('MISSING_CONFIG', 'config.yaml must contain a non-empty project_id', {
      file,
    })
  }
  if (typeof c.schema_version !== 'number' || c.schema_version !== 1) {
    throw new ProjectMemoryError(
      'INCONSISTENT',
      `config.yaml schema_version must be ${1}`,
      { file, schema_version: c.schema_version },
    )
  }
  const out: ConfigFile = {
    schema_version: c.schema_version,
    project_id: c.project_id,
    created_at: typeof c.created_at === 'string' ? c.created_at : '',
    extra_secret_patterns:
      c.extra_secret_patterns === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(c.extra_secret_patterns))
              throw new ProjectMemoryError(
                'INCONSISTENT',
                'config.yaml extra_secret_patterns must be an array of strings (fail closed, not silently disabled)',
                { file, extra_secret_patterns: c.extra_secret_patterns },
              )
            return c.extra_secret_patterns.filter((v): v is string => {
              assertSafeSecretPattern(v, 'extra_secret_patterns')
              return true
            })
          })(),
    canonical_state_file:
      typeof c.canonical_state_file === 'string' && c.canonical_state_file !== ''
        ? c.canonical_state_file
        : undefined,
    retrieval_gate:
      c.retrieval_gate === 'enabled' || c.retrieval_gate === 'disabled'
        ? c.retrieval_gate
        : 'first_ask', // unknown/missing => first_ask (opt-in, fail closed)
  }
  return out
}

/**
 * Validate a project-relative path: non-empty, not absolute, resolves inside
 * the project cwd, and never inside the .note-skills root. Existence is
 * checked by the caller. Used for canonical_state_file and promote targets.
 */
export function assertProjectRelativePath(cwd: string, rel: string, label: string): string {
  if (typeof rel !== 'string' || rel.trim() === '' || path.isAbsolute(rel)) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      `${label} must be a non-empty project-relative path (got ${JSON.stringify(rel)})`,
      { [label]: rel },
    )
  }
  const abs = path.resolve(cwd, rel)
  const back = path.relative(cwd, abs)
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new ProjectMemoryError('INVALID_INPUT', `${label} escapes the project: ${rel}`, { [label]: rel })
  }
  if (back === MEMORY_ROOT || back.startsWith(MEMORY_ROOT + path.sep)) {
    throw new ProjectMemoryError('INVALID_INPUT', `${label} must not point inside ${MEMORY_ROOT}: ${rel}`, {
      [label]: rel,
    })
  }
  return back
}

/** Create config.yaml + tree. Idempotent: existing config with the same project_id is reused. */
export function initProjectStorage(
  cwd: string,
  opts: { project_id: string; extra_secret_patterns?: string[]; canonical_state_file?: string },
): { config: ConfigFile; created: boolean } {
  assertProjectDir(cwd)
  assertMemoryRootSafe(cwd)
  // v0.3.x legacy data detection: .project-memory is NOT read by v0.4.0 and
  // old notes cannot auto-migrate (§7.3 re-binding semantics). Fail fast and
  // surface the migration need instead of silently starting a fresh store.
  const legacyRoot = path.join(cwd, '.project-memory')
  if (fs.existsSync(legacyRoot) && isValidLegacyRoot(legacyRoot)) {
    throw new ProjectMemoryError(
      'CONFLICT',
      `legacy v0.3.x memory root detected at .project-memory — v0.4.0 uses .note-skills and does ` +
        `not read old notes. Re-capture/acknowledge legacy pending (§7.3) or archive the old root ` +
        `before re-initializing (no automatic migration).`,
      { file: legacyRoot },
    )
  }
  if (!PROJECT_ID_RE.test(opts.project_id)) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      `project_id ${JSON.stringify(opts.project_id)} does not match ${PROJECT_ID_RE}`,
    )
  }
  if (opts.canonical_state_file !== undefined) {
    const rel = assertProjectRelativePath(cwd, opts.canonical_state_file, 'canonical_state_file')
    rejectSymlinkComponents(cwd, path.join(cwd, rel), 'canonical_state_file')
  }
  for (const pattern of opts.extra_secret_patterns ?? [])
    assertSafeSecretPattern(pattern, 'extra_secret_patterns')
  ensureMemoryDirs(cwd)
  const file = configPath(cwd)
  if (fs.existsSync(file)) {
    const existing = readConfig(cwd)
    if (existing.project_id !== opts.project_id) {
      throw new ProjectMemoryError(
        'CONFLICT',
        `config.yaml already exists with project_id="${existing.project_id}" (requested "${opts.project_id}")`,
        { file, existing: existing.project_id, requested: opts.project_id },
      )
    }
    return { config: existing, created: false }
  }
  const cfg: ConfigFile = {
    schema_version: 1,
    project_id: opts.project_id,
    created_at: new Date().toISOString(),
    ...(opts.extra_secret_patterns && opts.extra_secret_patterns.length
      ? { extra_secret_patterns: opts.extra_secret_patterns }
      : {}),
    ...(opts.canonical_state_file !== undefined
      ? { canonical_state_file: opts.canonical_state_file }
      : {}),
  }
  writeFileAtomic(file, yaml.stringify(cfg))
  // .note-skills/README.md: authority boundary + usage rules (kept minimal).
  const readme = `# Note Skills

Managed by the Note Skills core (filesystem-first, hook-enforced).

- Raw note objects: \`notes/<type>/\` (Markdown + YAML frontmatter).
- \`index/\` is derived and rebuildable — never edit by hand.
- \`config.yaml\` must contain \`project_id\`.
- Memory is NOT a source of truth. Canonical sources (spec, ADR, issue, …) win
  on conflict; notes carry \`authority: memory\` unless promoted.
`
  writeFileAtomic(path.join(memoryRoot(cwd), 'README.md'), readme)
  return { config: cfg, created: true }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function sha256hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/** Exact dedup fingerprint: normalized (type, title, summary) (§10.6). */
export function fingerprintOf(type: NoteType, title: string, summary: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return `sha256:${sha256hex(JSON.stringify([type, norm(title), norm(summary)]))}`
}

/** Stable filename slug derived from the title (§8.2: rename keeps identity). */
export function slug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || 'note'
}

export function relPath(cwd: string, abs: string): string {
  return path.relative(cwd, abs)
}

export function tryReadText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function tryReadJson<T>(file: string): T | null {
  const text = tryReadText(file)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Atomic write: tmp file in the same dir + fsync + rename. */
export function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.pm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, 'wx')
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw e
  }
}

/**
 * Best-effort all-or-nothing batch commit for small derived registries.
 *
 * Phase 1 (staging): every file is written + fsynced to a unique temp path in
 * its own directory while the ORIGINAL content is captured. Any staging
 * failure removes all temps and leaves every target untouched.
 *
 * Phase 2 (commit): temps are renamed into place in order. If a rename fails
 * mid-way, files already renamed are restored to their captured original
 * content (atomic write), the remaining temps are removed, and the original
 * error is rethrown. The restore is BEST-EFFORT, not crash-atomic: if the
 * restore write itself fails (disk-level fault), the restore error is
 * suppressed in favor of the original error and the store may be left
 * partially updated. Callers must therefore re-run reconcile for derived
 * registries after a thrown commit failure.
 */
export function writeFileAtomicBatch(files: Array<{ file: string; content: string }>): void {
  if (files.length === 0) return
  const staged: Array<{ tmp: string; file: string; original: string | null }> = []
  try {
    for (const { file, content } of files) {
      const dir = path.dirname(file)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = path.join(dir, `.pm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
      let fd: number | undefined
      try {
        fd = fs.openSync(tmp, 'wx')
        fs.writeFileSync(fd, content)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
      } catch (e) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd)
          } catch {
            /* ignore */
          }
        }
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        throw e
      }
      staged.push({ tmp, file, original: tryReadText(file) })
    }
  } catch (e) {
    // Aborted during staging: remove every staged temp; targets untouched.
    for (const { tmp } of staged) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
    throw e
  }
  const renamed: Array<{ file: string; original: string | null }> = []
  for (const item of staged) {
    try {
      fs.renameSync(item.tmp, item.file)
      renamed.push({ file: item.file, original: item.original })
    } catch (e) {
      // Roll back files already committed in this batch, then drop remaining temps.
      for (const done of renamed.reverse()) {
        try {
          if (done.original === null) {
            fs.unlinkSync(done.file)
          } else {
            writeFileAtomic(done.file, done.original)
          }
        } catch {
          /* restore is best-effort on top of the failing rename */
        }
      }
      // Remove temps whose rename never happened (the failed one + all later).
      for (const pending of staged) {
        try {
          fs.unlinkSync(pending.tmp)
        } catch {
          /* ignore */
        }
      }
      throw e
    }
  }
}

/* ------------------------------------------------------------------ */
/* Note file parsing / serialization                                   */
/* ------------------------------------------------------------------ */

export function parseNoteFile(content: string): {
  noteObj: Record<string, unknown>
  body: string
} {
  if (!content.startsWith('---\n')) {
    throw new Error('missing frontmatter opening delimiter')
  }
  const end = content.indexOf('\n---', 4)
  if (end < 0) {
    throw new Error('unterminated frontmatter block')
  }
  const fmRaw = content.slice(4, end)
  const rest = content.slice(end + 4).replace(/^\r?\n+/, '')
  const parsed: unknown = yaml.parse(fmRaw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter is not an object')
  }
  return { noteObj: parsed as Record<string, unknown>, body: rest }
}

export function serializeNote(note: Note, body: string): string {
  const fm = yaml
    .stringify(note as unknown as Record<string, unknown>, { defaultStringType: 'PLAIN' })
    .trimEnd()
  return `---\n${fm}\n---\n${body ?? ''}`
}

/* ------------------------------------------------------------------ */
/* L1 Working Context Parsing / Serialization / Validation             */
/* ------------------------------------------------------------------ */

export function parseProjectContext(raw: string): {
  metadata: ProjectContextMetadata
  body: string
} {
  if (!raw.startsWith('---\n')) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT missing frontmatter opening delimiter')
  }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT unterminated frontmatter block')
  }
  const fmRaw = raw.slice(4, end)
  const rest = raw.slice(end + 4).replace(/^\r?\n+/, '')
  let parsed: unknown
  try {
    parsed = yaml.parse(fmRaw)
  } catch (e) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      `PROJECT_CONTEXT frontmatter is not valid YAML: ${(e as Error).message}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT frontmatter must be an object')
  }
  return { metadata: parsed as unknown as ProjectContextMetadata, body: rest }
}

export function serializeProjectContext(metadata: ProjectContextMetadata, body: string): string {
  const fm = yaml
    .stringify(metadata as unknown as Record<string, unknown>, { defaultStringType: 'PLAIN' })
    .trimEnd()
  return `---\n${fm}\n---\n\n${body.trim()}\n`
}

export function validateProjectContext(
  context: { metadata: ProjectContextMetadata; body: string; raw: string },
  expectedProjectId: string,
): void {
  const rawBytes = Buffer.byteLength(context.raw, 'utf8')
  if (rawBytes > PROJECT_CONTEXT_MAX_BYTES) {
    throw new ProjectMemoryError(
      'BUDGET_EXCEEDED',
      `PROJECT_CONTEXT size (${rawBytes} bytes) exceeds hard cap of ${PROJECT_CONTEXT_MAX_BYTES} bytes (5KB)`,
      { bytes: rawBytes, max: PROJECT_CONTEXT_MAX_BYTES },
    )
  }
  const m = context.metadata
  if (m.schema_version !== 1) {
    throw new ProjectMemoryError('INVALID_INPUT', `PROJECT_CONTEXT schema_version must be 1, got ${m.schema_version}`)
  }
  if (m.project_id !== expectedProjectId) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      `PROJECT_CONTEXT project_id mismatch: expected "${expectedProjectId}", got "${m.project_id}"`,
      { expected: expectedProjectId, actual: m.project_id },
    )
  }
  if (m.authority !== 'working_projection') {
    throw new ProjectMemoryError(
      'POLICY_VIOLATION',
      `PROJECT_CONTEXT authority must be "working_projection" (§2), got "${m.authority}"`,
      { authority: m.authority },
    )
  }
  if (!Number.isInteger(m.context_revision) || m.context_revision < 1) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT context_revision must be a positive integer')
  }
  if (!CHECKPOINT_ID_RE.test(m.checkpoint_id)) {
    throw new ProjectMemoryError('INVALID_INPUT', `PROJECT_CONTEXT checkpoint_id must match ${CHECKPOINT_ID_RE}`)
  }
  if (!m.covered_through_entry_id || typeof m.covered_through_entry_id !== 'string') {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT covered_through_entry_id is required')
  }
  if (typeof m.source_session_id !== 'string' || m.source_session_id.trim() === '') {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT source_session_id must be a non-empty string')
  }
  const SHA256_OPT_RE = /^(?:|[0-9a-f]{64})$/
  if (typeof m.base_context_sha256 !== 'string' || !SHA256_OPT_RE.test(m.base_context_sha256)) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      'PROJECT_CONTEXT base_context_sha256 must be empty or 64 hex characters',
    )
  }
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
  if (typeof m.generated_at !== 'string' || !ISO_RE.test(m.generated_at)) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT generated_at must be valid ISO-8601 timestamp')
  }
  if (m.git_branch !== undefined && (typeof m.git_branch !== 'string' || !/^[a-zA-Z0-9_\-./]+$/.test(m.git_branch))) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT git_branch must be valid branch name string')
  }
  if (m.git_head !== undefined && (typeof m.git_head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(m.git_head))) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT git_head must be a valid git commit hash (7 to 64 hex characters)')
  }
  if (m.workspace_fingerprint !== undefined && typeof m.workspace_fingerprint !== 'string') {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT workspace_fingerprint must be a string')
  }

  // Schema allowlist: reject any unexpected metadata fields
  const ALLOWED_METADATA_KEYS = new Set([
    'schema_version',
    'project_id',
    'authority',
    'context_revision',
    'checkpoint_id',
    'source_session_id',
    'covered_through_entry_id',
    'git_branch',
    'git_head',
    'workspace_fingerprint',
    'base_context_sha256',
    'generated_at',
    'negative_constraints_relaxation',
  ])
  for (const key of Object.keys(m)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new ProjectMemoryError(
        'INVALID_INPUT',
        `PROJECT_CONTEXT frontmatter contains unauthorized field "${key}"`,
        { field: key },
      )
    }
  }

  if (m.negative_constraints_relaxation !== undefined) {
    if (typeof m.negative_constraints_relaxation !== 'object' || m.negative_constraints_relaxation === null) {
      throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT negative_constraints_relaxation must be an object')
    }
    const r = m.negative_constraints_relaxation as unknown as Record<string, unknown>
    if (typeof r.checkpoint_id !== 'string' || !CHECKPOINT_ID_RE.test(r.checkpoint_id)) {
      throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT negative_constraints_relaxation.checkpoint_id is invalid')
    }
    if (typeof r.reason !== 'string' || r.reason.trim().length === 0) {
      throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT negative_constraints_relaxation.reason is invalid')
    }
    if (!Array.isArray(r.removed_constraints)) {
      throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT negative_constraints_relaxation.removed_constraints must be an array')
    }
  }

  // Validate required sections in body (§3.3 Anti-Mini-Wiki Rules)
  const lowerBody = context.body.toLowerCase()
  const hasObjective = /##\s*current\s*objective/i.test(lowerBody)
  const hasNextAction = /##\s*next\s*action/i.test(lowerBody)
  const hasNegativeConstraints = /##\s*(?:negative\s*constraints|do\s*not\s*assume)/i.test(lowerBody)

  if (!hasObjective) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT body is missing required "## Current Objective" section')
  }
  if (!hasNextAction) {
    throw new ProjectMemoryError('INVALID_INPUT', 'PROJECT_CONTEXT body is missing required "## Next Action" section')
  }
  if (!hasNegativeConstraints) {
    throw new ProjectMemoryError(
      'INVALID_INPUT',
      'PROJECT_CONTEXT body is missing required "## Negative Constraints / Do Not Assume" section (§3.3)',
    )
  }
}

export const ABSENCE_OF_CONSTRAINTS_PATTERN =
  /^(?:(?:(?:negative\s+)?constraints?|notes?|(?:负向)?(?:约束|限制|要求))[:：]\s*)?(?:none(?:\s+(?:specified|reported|currently|at\s+this\s+time|yet|known))?|nothing(?:\s+(?:specified|here|to\s+report|yet))?|no(?:\s+(?:known\s+|additional\s+|special\s+)?(?:negative\s+)?(?:constraints?|special\s+constraints?|limitations?|restrictions?|assumptions?)(?:\s+(?:specified|reported|currently|at\s+this\s+time|yet|known))?)|not(?:\s+(?:specified|applicable|defined|known))|there\s+(?:are|aren't|is|isn't)\s+(?:no|any)\s+(?:known\s+|additional\s+|special\s+)?(?:negative\s+)?(?:constraints?|limitations?|restrictions?)|n[\/.]?a[\/.]?|nil|empty|null|tbd|todo|none\.|n\/a\.|(?:当前|暂时|目前)?(?:无|暂无|没有|未指定|不适用|尚无|空)(?:任何)?(?:负向)?(?:特别|特殊|附加)?(?:约束|限制|要求)?)[.!?。！？\s]*$/i

export function normalizeConstraint(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[-*•\d.\s]+/, '')
    .replace(/^~~|~~$/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[.!?;:。！？；：\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractSubstantiveConstraints(body: string): string[] {
  const match = body.match(
    /##\s*(?:negative\s*constraints|do\s*not\s*assume)(?:\s*[/|]\s*(?:negative\s*constraints|do\s*not\s*assume))?\s*\n+([\s\S]*?)(?=\n+##|$)/i,
  )
  const rawContent = match?.[1]
  if (!rawContent) return []

  // 1. Strip HTML comments so commented-out constraints are never treated as active
  const uncommented = rawContent.replace(/<!--[\s\S]*?-->/g, '')

  const lines = uncommented
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const inactiveMarkerPattern =
    /^(?:(?:this\s+constraint\s+is\s+)?(?:no\s+longer\s+active|inactive|historical|removed|deprecated|obsolete|disabled|ignored?|cancelled?|void)(?:\s*[:：\-])?|ignore(?:\s+the\s+following)?(?:\s+old)?\s+(?:rule|constraint)[:：]?|【已废弃】|【已删除】|【已作废】|已废弃|已删除|已作废)/i

  const results: string[] = []
  for (const rawLine of lines) {
    const strippedBullet = rawLine.replace(/^[-*•\d.\s]+/, '').trim()
    // 2. Ignore strikethrough lines: e.g. ~~Do not deploy~~
    if (/^~~[\s\S]*~~$/.test(strippedBullet)) {
      continue
    }

    // 3. Ignore lines explicitly marked as inactive / historical / removed
    if (inactiveMarkerPattern.test(strippedBullet)) {
      continue
    }

    // 4. Ignore lines matching absence-of-constraints declarations (e.g. "none", "n/a", etc.)
    if (ABSENCE_OF_CONSTRAINTS_PATTERN.test(strippedBullet)) {
      continue
    }

    if (strippedBullet.length >= 3) {
      results.push(strippedBullet)
    }
  }

  return results
}

export function extractSubstantiveConstraintSet(body: string): Set<string> {
  const list = extractSubstantiveConstraints(body)
  return new Set(list.map(normalizeConstraint).filter(Boolean))
}

export function isSubstantiveRelaxationReason(reason: string): boolean {
  const trimmed = reason.trim()
  if (trimmed.length < 15) return false

  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    if (trimmed.length < 10) return false
    const uniqueChars = new Set([...trimmed.replace(/[^\u4e00-\u9fa5]/g, '')])
    if (uniqueChars.size < 5) return false
    if (/^(?:测试|占位|暂无|无理由|跳过|忽略)+$/i.test(trimmed)) return false
    return true
  }

  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 3) return false

  const uniqueTokens = new Set(tokens.map((t) => t.toLowerCase()))
  if (uniqueTokens.size <= 1) return false

  const placeholderTokens = new Set([
    'none', 'n/a', 'na', 'nil', 'null', 'tbd', 'todo', 'test', 'testing',
    'placeholder', 'dummy', 'not', 'valid', 'reason', 'reasons', 'no',
    'just', 'because', 'bypass', 'skip', 'relax', 'delete', 'remove',
    'clear', 'at', 'all', 'any', 'some', 'thing', 'text', 'sample', 'foo', 'bar'
  ])

  const nonPlaceholderCount = tokens.filter(
    (t) => !placeholderTokens.has(t.toLowerCase().replace(/[^a-z0-9]/g, ''))
  ).length

  return nonPlaceholderCount >= 2
}

export function containsSubstantiveConstraint(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
  if (lines.length === 0) return false

  const substantive = lines.filter((line) => {
    if (line.length < 3) return false
    return !ABSENCE_OF_CONSTRAINTS_PATTERN.test(line)
  })
  return substantive.length > 0
}

export function extractNegativeConstraints(body: string): string | undefined {
  const match = body.match(
    /##\s*(?:negative\s*constraints|do\s*not\s*assume)(?:\s*[/|]\s*(?:negative\s*constraints|do\s*not\s*assume))?\s*\n+([\s\S]*?)(?=\n+##|$)/i,
  )
  const content = match?.[1]?.trim()
  if (!content) return undefined
  if (!containsSubstantiveConstraint(content)) return undefined
  return content
}

export function tryReadGitIdentity(cwd: string): { branch?: string; head?: string } {
  try {
    const gitDir = path.join(cwd, '.git')
    if (!fs.existsSync(gitDir)) return {}
    let headPath = path.join(gitDir, 'HEAD')
    let commonGitDir = gitDir
    const st = fs.statSync(gitDir)
    if (!st.isDirectory()) {
      const gitFileContent = fs.readFileSync(gitDir, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/i.exec(gitFileContent)
      if (match && match[1]) {
        const resolvedGitDir = path.resolve(cwd, match[1])
        headPath = path.join(resolvedGitDir, 'HEAD')
        commonGitDir = resolvedGitDir
        // In linked git worktree, commondir points to the main repository .git
        const commonFile = path.join(resolvedGitDir, 'commondir')
        if (fs.existsSync(commonFile)) {
          const commonRel = fs.readFileSync(commonFile, 'utf8').trim()
          commonGitDir = path.resolve(resolvedGitDir, commonRel)
        }
      }
    }
    if (!fs.existsSync(headPath)) return {}
    const headContent = fs.readFileSync(headPath, 'utf8').trim()
    const branchMatch = /^ref: refs\/heads\/(.+)$/.exec(headContent)
    if (branchMatch && branchMatch[1]) {
      const branch = branchMatch[1]
      let head: string | undefined
      // Try resolving head from worktree-local refs, common refs, or packed-refs
      const candidateRefFiles = [
        path.join(path.dirname(headPath), 'refs', 'heads', branch),
        path.join(commonGitDir, 'refs', 'heads', branch),
      ]
      for (const rf of candidateRefFiles) {
        if (fs.existsSync(rf)) {
          head = fs.readFileSync(rf, 'utf8').trim()
          break
        }
      }
      if (!head) {
        const packedFiles = [path.join(commonGitDir, 'packed-refs'), path.join(path.dirname(headPath), 'packed-refs')]
        for (const pf of packedFiles) {
          if (fs.existsSync(pf)) {
            const packedContent = fs.readFileSync(pf, 'utf8')
            const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const match = new RegExp(`^([0-9a-f]{40})\\s+refs/heads/${escaped}$`, 'm').exec(packedContent)
            if (match && match[1]) {
              head = match[1]
              break
            }
          }
        }
      }
      return { branch, head }
    } else if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return { head: headContent, branch: undefined }
    }
    return {}
  } catch {
    return {}
  }
}

export function nextFreeCheckpointId(dir: string): string {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 'CP-0001'
  }
  let maxSeq = 0
  const re = /^CP-(\d{4,})\.md$/
  for (const name of names) {
    const m = re.exec(name)
    if (m) {
      const seq = parseInt(m[1] ?? '0', 10)
      if (seq > maxSeq) maxSeq = seq
    }
  }
  return `CP-${String(maxSeq + 1).padStart(4, '0')}`
}

export function readProjectContext(cwd: string, opts: { validate?: boolean } = {}): ProjectContext | null {
  assertMemoryRootSafe(cwd)
  const file = projectContextPath(cwd)
  if (!fs.existsSync(file)) return null
  rejectSymlinkComponents(cwd, file, PROJECT_CONTEXT_FILENAME)
  const raw = tryReadText(file)
  if (raw === null) return null
  const { metadata, body } = parseProjectContext(raw)
  const sha256 = sha256hex(raw)
  const context: ProjectContext = { metadata, body, raw, sha256 }
  if (opts.validate) {
    const cfg = readConfig(cwd)
    validateProjectContext(context, cfg.project_id)
  }
  return context
}

export function readFlushReceipt(cwd: string, checkpointId: string): FlushReceipt | null {
  assertMemoryRootSafe(cwd)
  const file = flushReceiptPath(cwd, checkpointId)
  if (!fs.existsSync(file)) return null
  rejectSymlinkComponents(cwd, file, `checkpoints/${checkpointId}.receipt.json`)
  return tryReadJson<FlushReceipt>(file)
}

/** All note file paths across the six type directories (sorted, stable). */
export function noteFilesIn(cwd: string): string[] {
  const out: string[] = []
  for (const d of TYPE_DIRS) {
    const dir = path.join(notesRoot(cwd), d)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
    } catch {
      continue
    }
    names.sort()
    for (const n of names) out.push(path.join(dir, n))
  }
  return out
}

export interface ScanIssue {
  file: string
  message: string
}

/** Scan all raw notes; per-file errors are collected (reconcile surfaces them). */
export function scanNotes(cwd: string): { notes: ScannedRaw[]; errors: ScanIssue[] } {
  assertMemoryRootSafe(cwd)
  const notes: ScannedRaw[] = []
  const errors: ScanIssue[] = []
  for (const file of noteFilesIn(cwd)) {
    try {
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink()) {
        errors.push({ file, message: `note file is a symlink — rejected (must not read outside the project)` })
        continue
      }
    } catch {
      errors.push({ file, message: `unreadable note file` })
      continue
    }
    const content = tryReadText(file)
    if (content === null) {
      errors.push({ file, message: `unreadable note file` })
      continue
    }
    const sha256 = sha256hex(content)
    try {
      const { noteObj, body } = parseNoteFile(content)
      notes.push({ noteObj, body, file, sha256 })
    } catch (e) {
      errors.push({ file, message: `parse error: ${(e as Error).message}` })
    }
  }
  return { notes, errors }
}

export interface ScannedRaw {
  noteObj: Record<string, unknown>
  body: string
  file: string
  sha256: string
}

/* ------------------------------------------------------------------ */
/* ID allocation (exclusive create, §15.5 invariant 14)                */
/* ------------------------------------------------------------------ */

function usedIdsIn(dir: string, abbr: string): Set<string> {
  const ids = new Set<string>()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return ids
  }
  const re = new RegExp(`^PM-${abbr}-(\\d{4,})`)
  for (const n of names) {
    const m = re.exec(n)
    if (m) ids.add(`PM-${abbr}-${m[1]}`)
  }
  return ids
}

function nextFreeId(dir: string, abbr: string): string {
  const used = usedIdsIn(dir, abbr)
  let seq = 1
  for (let i = 0; i < 1_000_000; i++) {
    const id = `PM-${abbr}-${String(seq).padStart(4, '0')}`
    if (!used.has(id)) return id
    seq++
  }
  throw new ProjectMemoryError('CONFLICT', 'note id space exhausted')
}

/**
 * Create the note file under an ID reservation that is INDEPENDENT of the
 * final filename. The reservation lock is `<id>.lock` (slug-free), so two
 * concurrent writers that pick the same candidate ID can NEVER both succeed
 * — even when their titles produce different slugs. The final note file is
 * written with plain 'w' (we hold the reservation) and the lock is removed in
 * a finally block on both success and failure. A stale lock from a crash
 * simply leaves that ID reserved (skipped by nextFreeId) — uniqueness is
 * preserved, gaps are harmless (invariant 1, invariant 14).
 */
export function createNoteFileExclusive(cwd: string, note: Note, body: string): { id: string; file: string } {
  const dir = typeDir(cwd, note.type)
  fs.mkdirSync(dir, { recursive: true })
  const abbr = TYPE_ABBR[note.type]
  assertMemoryRootSafe(cwd)
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const id = nextFreeId(dir, abbr)
    const lockFile = path.join(dir, `${id}.lock`)
    let lockFd: number | undefined
    try {
      lockFd = fs.openSync(lockFile, 'wx')
    } catch (e) {
      // EEXIST: another process holds this ID (or a stale lock does) — retry
      // with the next free ID. Any other error is real.
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      const file = path.join(dir, `${id}-${slug(note.title)}.md`)
      const content = serializeNote({ ...note, id }, body)
      // 'wx': never follow a planted symlink at the note path; EEXIST under a
      // held reservation is an anomaly — fail loudly instead of writing outside.
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(fd, content)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return { id, file }
    } finally {
      try {
        fs.closeSync(lockFd as number)
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockFile)
      } catch {
        /* ignore */
      }
    }
  }
  throw new ProjectMemoryError('CONFLICT', 'unable to allocate a unique note id after many attempts')
}

/** Overwrite a note file atomically (update/close/promote paths). */
export function writeNoteFile(file: string, note: Note, body: string): void {
  writeFileAtomic(file, serializeNote(note, body))
}

/**
 * Compare-and-swap a note revision. Callers must also hold the per-note lock;
 * the hash check catches manual/non-cooperating edits made after the read.
 */
export function writeNoteFileCas(
  file: string,
  expectedSha256: string,
  note: Note,
  body: string,
): string {
  const current = tryReadText(file)
  if (current === null)
    throw new ProjectMemoryError('CONFLICT', `note changed or disappeared before write: ${file}`, { file })
  const actualSha256 = sha256hex(current)
  if (actualSha256 !== expectedSha256)
    throw new ProjectMemoryError('CONFLICT', `note changed after it was read; retry against the latest revision`, {
      file,
      expectedSha256,
      actualSha256,
    })
  const content = serializeNote(note, body)
  writeFileAtomic(file, content)
  const written = tryReadText(file)
  if (written === null || sha256hex(written) !== sha256hex(content))
    throw new ProjectMemoryError('INTERNAL', `note write-then-readback failed: ${file}`, { file })
  return sha256hex(content)
}

/* ------------------------------------------------------------------ */
/* Derived index (§15.3, invariant 9)                                  */
/* ------------------------------------------------------------------ */

export const INDEX_NOTES_FILE = 'notes.json'
export const INDEX_TRIGGERS_FILE = 'triggers.json'

export interface IndexNoteEntry {
  id: string
  type: NoteType
  status: string
  title: string
  summary: string
  priority?: string
  authority: string
  sensitivity?: string
  fingerprint: string
  /** Project-relative file path. */
  file: string
  sha256: string
  created_at: string
  updated_at: string
  promotion_status: string
  has_trigger: boolean
  source_ref_count: number
}

export interface IndexTriggerEntry {
  id: string
  title: string
  type: NoteType
  status: string
  active: boolean
  mode?: string
  conditions: TriggerCondition[]
}

export interface NotesIndexFile {
  schema_version: number
  project_id: string
  generated_at: string
  notes: IndexNoteEntry[]
}

export interface TriggersIndexFile {
  schema_version: number
  project_id: string
  generated_at: string
  triggers: IndexTriggerEntry[]
}

export interface IndexSnapshot {
  notes: NotesIndexFile | null
  triggers: TriggersIndexFile | null
}

export function indexPaths(cwd: string): { notes: string; triggers: string } {
  return {
    notes: path.join(indexDir(cwd), INDEX_NOTES_FILE),
    triggers: path.join(indexDir(cwd), INDEX_TRIGGERS_FILE),
  }
}

export function writeIndexAtomic(
  cwd: string,
  notes: IndexNoteEntry[],
  triggers: IndexTriggerEntry[],
  projectId: string,
): void {
  const now = new Date().toISOString()
  const p = indexPaths(cwd)
  writeFileAtomic(p.notes, JSON.stringify({ schema_version: 1, project_id: projectId, generated_at: now, notes }, null, 2))
  writeFileAtomic(p.triggers, JSON.stringify({ schema_version: 1, project_id: projectId, generated_at: now, triggers }, null, 2))
}

export function readIndex(cwd: string): IndexSnapshot {
  const p = indexPaths(cwd)
  // Derived index files must never be symlinks — reject before reading.
  rejectSymlinkComponents(cwd, p.notes, 'index/notes.json', 'INCONSISTENT')
  rejectSymlinkComponents(cwd, p.triggers, 'index/triggers.json', 'INCONSISTENT')
  const parse = <T>(file: string): T | null => {
    const text = tryReadText(file)
    if (text === null) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }
  return {
    notes: parse<NotesIndexFile>(p.notes),
    triggers: parse<TriggersIndexFile>(p.triggers),
  }
}

export function indexNoteEntries(cwd: string, valid: ScannedRaw[]): { notes: IndexNoteEntry[]; triggers: IndexTriggerEntry[] } {
  const notes: IndexNoteEntry[] = []
  const triggers: IndexTriggerEntry[] = []
  for (const raw of valid) {
    const note = raw.noteObj as unknown as Note
    if (typeof note.id !== 'string' || typeof note.type !== 'string') continue
    const trigger = note.trigger as Trigger | null | undefined
    const haveTrigger = !!trigger && Array.isArray(trigger.conditions) && trigger.conditions.length > 0
    notes.push({
      id: note.id,
      type: note.type as NoteType,
      status: typeof note.status === 'string' ? note.status : '',
      title: typeof note.title === 'string' ? note.title : '',
      summary: typeof note.summary === 'string' ? note.summary : '',
      priority: typeof note.priority === 'string' ? note.priority : undefined,
      authority: typeof note.authority === 'string' ? note.authority : 'memory',
      sensitivity: typeof note.sensitivity === 'string' ? note.sensitivity : undefined,
      fingerprint: typeof note.fingerprint === 'string' ? note.fingerprint : '',
      file: relPath(cwd, raw.file),
      sha256: raw.sha256,
      created_at: typeof note.created_at === 'string' ? note.created_at : '',
      updated_at: typeof note.updated_at === 'string' ? note.updated_at : '',
      promotion_status:
        note.promotion && typeof note.promotion === 'object'
          ? String((note.promotion as { status?: unknown }).status ?? 'not_promoted')
          : 'not_promoted',
      has_trigger: haveTrigger,
      source_ref_count: Array.isArray(note.source_refs) ? note.source_refs.length : 0,
    })
    if (haveTrigger && trigger) {
      triggers.push({
        id: note.id,
        title: typeof note.title === 'string' ? note.title : '',
        type: note.type as NoteType,
        status: typeof note.status === 'string' ? note.status : '',
        active: !isTerminal(note.type as NoteType, typeof note.status === 'string' ? note.status : ''),
        mode: trigger.mode,
        conditions: trigger.conditions,
      })
    }
  }
  return { notes, triggers }
}

/* ------------------------------------------------------------------ */
/* Backlinks (§12.3, invariant 8)                                      */
/* ------------------------------------------------------------------ */

export const IN_FILE_MARKER_RE =
  /note-skills-derived-from:\s*([^;\s]+)\s*;\s*promotion_id:\s*([^;\s>]+)/

export function inFileMarker(noteId: string, promotionId: string, promotedAt: string): string {
  return `<!-- note-skills-derived-from: ${noteId}; promotion_id: ${promotionId}; promoted_at: ${promotedAt} -->`
}

/** Plain-text line marker (e.g. .txt targets) with the same parse format. */
export function inFileMarkerLine(noteId: string, promotionId: string, promotedAt: string): string {
  return `# note-skills-derived-from: ${noteId}; promotion_id: ${promotionId}; promoted_at: ${promotedAt}`
}

/** Deterministic name for the .note-skills/backlinks/<hash>.md record. */
export function linkFileFor(cwd: string, relTarget: string): string {
  return path.join(backlinksDir(cwd), `bl-${sha256hex(relTarget).slice(0, 12)}.md`)
}

export interface BacklinkRecord {
  file: string
  noteId: string
  promotion_id: string
  target: string
  kind?: string
  promoted_at?: string
}

export function parseBacklinkFile(content: string): BacklinkRecord {
  const grab = (prefix: string, re: RegExp): string => {
    const m = re.exec(content)
    return m ? m[1].trim() : ''
  }
  return {
    file: '',
    noteId: grab('derived_from', /^\s*-\s*derived_from:\s*(.+)$/m),
    promotion_id: grab('promotion_id', /^\s*-\s*promotion_id:\s*(.+)$/m),
    target: grab('target', /^\s*-\s*target:\s*(.+)$/m),
    kind: grab('kind', /^\s*-\s*kind:\s*(.+)$/m) || undefined,
    promoted_at: grab('promoted_at', /^\s*-\s*promoted_at:\s*(.+)$/m) || undefined,
  }
}

export function parseBacklinkFileThatExists(file: string): BacklinkRecord | null {
  const content = tryReadText(file)
  if (content === null) return null
  const rec = parseBacklinkFile(content)
  if (!rec.noteId || !rec.promotion_id || !rec.target) return null
  return { ...rec, file }
}

/** Read all link-file backlink records in .note-skills/backlinks/. */
export function readBacklinks(cwd: string): BacklinkRecord[] {
  const dir = backlinksDir(cwd)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
  const out: BacklinkRecord[] = []
  for (const n of names.sort()) {
    const file = path.join(dir, n)
    // Backlink records must never be symlinks — reject before reading.
    rejectSymlinkComponents(cwd, file, 'backlinks/' + n, 'INCONSISTENT')
    const rec = parseBacklinkFileThatExists(file)
    if (rec) out.push(rec)
  }
  return out
}

export function serializeBacklinkFile(rec: Omit<BacklinkRecord, 'file'>): string {
  return [
    '# Note Skills backlink',
    '',
    `- target: ${rec.target}`,
    `- kind: ${rec.kind ?? 'file'}`,
    `- derived_from: ${rec.noteId}`,
    `- promotion_id: ${rec.promotion_id}`,
    `- promoted_at: ${rec.promoted_at ?? ''}`,
    '',
  ].join('\n')
}

// Kept for callers that only need the "is this an EEXIST" style check.
export function isEexist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'EEXIST'
}

/* ------------------------------------------------------------------ */
/* Transaction locks (§12.3 — cross-process exclusivity)               */
/* ------------------------------------------------------------------ */

/** Deterministic per-target lock path: promote-<hash16(rel target)>.lock. */
export function promoteLockPath(cwd: string, relTarget: string): string {
  return path.join(locksDir(cwd), `promote-${sha256hex(relTarget).slice(0, 16)}.lock`)
}

export function fingerprintLockPath(cwd: string, fingerprint: string): string {
  return path.join(locksDir(cwd), `fingerprint-${sha256hex(fingerprint).slice(0, 24)}.lock`)
}

export function noteLockPath(cwd: string, noteId: string): string {
  return path.join(locksDir(cwd), `note-${noteId}.lock`)
}

export function approvalLockPath(cwd: string, approvalRef: string): string {
  return path.join(locksDir(cwd), `approval-${approvalRef}.lock`)
}

export function pendingLockPath(cwd: string): string {
  return path.join(locksDir(cwd), 'pending-captures.lock')
}

export interface LockOptions {
  /** Bounded wait for cooperating short transactions; zero means fail fast. */
  waitMs?: number
  retryMs?: number
}

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4))

/**
 * Acquire an O_EXCL cross-process lock and persist diagnostics. Locks are never
 * silently stolen: a crashed owner is surfaced by reconcile instead of risking
 * two simultaneous writers. Short capture/note operations may wait boundedly.
 */
export function acquireLockFile(
  lockPath: string,
  meta: Record<string, unknown>,
  opts: LockOptions = {},
): number {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const waitMs = Math.max(0, opts.waitMs ?? 0)
  const retryMs = Math.max(1, opts.retryMs ?? 10)
  const deadline = Date.now() + waitMs
  let fd: number
  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (Date.now() >= deadline) {
        throw new ProjectMemoryError(
          'CONFLICT',
          `another transaction holds ${path.basename(lockPath)} — retry after it finishes or reconcile a crashed lock`,
          { lock: lockPath, ...meta },
        )
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, Math.min(retryMs, Math.max(1, deadline - Date.now())))
    }
  }
  try {
    const payload = JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
      ...meta,
    })
    fs.writeFileSync(fd, payload)
    fs.fsyncSync(fd)
    return fd
  } catch (e) {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
    throw e
  }
}

/** Release a lock (best effort): close fd, then remove the lock file. */
export function releaseLockFile(lockPath: string, fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath)
  } catch {
    /* ignore */
  }
}