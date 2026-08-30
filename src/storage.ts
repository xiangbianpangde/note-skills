/**
 * storage.ts — filesystem layer for Project Memory.
 *
 * Responsibilities (all deterministic, no AI dependency):
 *   - .project-memory/ layout: config.yaml, notes/<type-dir>/, index/, backlinks/
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

import { TYPE_ABBR, isTerminal, ProjectMemoryError } from './model.ts'
import type { ErrorCode, Note, NoteType, Trigger, TriggerCondition } from './model.ts'

/* ------------------------------------------------------------------ */
/* Layout (§15.3)                                                      */
/* ------------------------------------------------------------------ */

export const MEMORY_ROOT = '.project-memory'
export const CONFIG_FILE = 'config.yaml'
export const NOTES_DIR = 'notes'
export const INDEX_DIR = 'index'
export const BACKLINKS_DIR = 'backlinks'
export const LOCKS_DIR = 'locks'
export const APPROVALS_DIR = 'approvals'
export const PENDING_DIR = 'pending'

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
 * Fail-closed guard for the whole .project-memory tree: the memory root, its
 * fixed subdirectories (notes, index, backlinks, the six type dirs) must never
 * be symlinks — otherwise config/note/index writes could land outside the
 * project, or reads could reach outside content. Missing components (not yet
 * created) are fine. Called before every memory-root write AND read.
 */
export function assertMemoryRootSafe(cwd: string): void {
  const targets: Array<[string, string]> = [
    [memoryRoot(cwd), '.project-memory'],
    [notesRoot(cwd), '.project-memory/notes'],
    [indexDir(cwd), '.project-memory/index'],
    [backlinksDir(cwd), '.project-memory/backlinks'],
    [locksDir(cwd), '.project-memory/locks'],
    [approvalsDir(cwd), '.project-memory/approvals'],
    [pendingDir(cwd), '.project-memory/pending'],
    ...TYPE_DIRS.map((d) => [path.join(notesRoot(cwd), d), `.project-memory/notes/${d}`] as [string, string]),
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

/** Create the full .project-memory tree (idempotent). */
export function ensureMemoryDirs(cwd: string): void {
  assertMemoryRootSafe(cwd)
  fs.mkdirSync(notesRoot(cwd), { recursive: true })
  for (const d of TYPE_DIRS) fs.mkdirSync(path.join(notesRoot(cwd), d), { recursive: true })
  fs.mkdirSync(indexDir(cwd), { recursive: true })
  fs.mkdirSync(backlinksDir(cwd), { recursive: true })
  fs.mkdirSync(locksDir(cwd), { recursive: true })
  fs.mkdirSync(approvalsDir(cwd), { recursive: true })
  fs.mkdirSync(pendingDir(cwd), { recursive: true })
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
   * project, outside .project-memory. When unset (or the file is absent),
   * triggers are NOT evaluated — never guessed, and never self-triggered from
   * notes or from state inside .project-memory (§11.7–§11.8).
   */
  canonical_state_file?: string
}

export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
    extra_secret_patterns: Array.isArray(c.extra_secret_patterns)
      ? c.extra_secret_patterns.filter((v): v is string => typeof v === 'string')
      : undefined,
    canonical_state_file:
      typeof c.canonical_state_file === 'string' && c.canonical_state_file !== ''
        ? c.canonical_state_file
        : undefined,
  }
  return out
}

/**
 * Validate a project-relative path: non-empty, not absolute, resolves inside
 * the project cwd, and never inside the .project-memory root. Existence is
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
  // .project-memory/README.md: authority boundary + usage rules (kept minimal).
  const readme = `# Project Memory

Managed by the Project Memory core (filesystem-first, hook-enforced).

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
 * error is rethrown — restoring the store to its pre-commit state unless the
 * restore itself fails (disk-level fault, unrecoverable).
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
  /project-memory-derived-from:\s*([^;\s]+)\s*;\s*promotion_id:\s*([^;\s>]+)/

export function inFileMarker(noteId: string, promotionId: string, promotedAt: string): string {
  return `<!-- project-memory-derived-from: ${noteId}; promotion_id: ${promotionId}; promoted_at: ${promotedAt} -->`
}

/** Plain-text line marker (e.g. .txt targets) with the same parse format. */
export function inFileMarkerLine(noteId: string, promotionId: string, promotedAt: string): string {
  return `# project-memory-derived-from: ${noteId}; promotion_id: ${promotionId}; promoted_at: ${promotedAt}`
}

/** Deterministic name for the .project-memory/backlinks/<hash>.md record. */
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

/** Read all link-file backlink records in .project-memory/backlinks/. */
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
    '# Project Memory backlink',
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