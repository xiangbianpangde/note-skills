/**
 * index.ts — Project Memory core entry point.
 *
 * Exports the full deterministic core API + types for Pi extensions, skills
 * and tests. The core itself has no AI/model dependency; the only runtime
 * dependency is `yaml` (runtime dep list: yaml only).
 *
 * Typical extension flow:
 *   const pm = openProject(cwd)                 // or initProject(cwd, {...}) first
 *   pm.capture({ type, title, summary, rationale, source_refs, trigger, ... })
 *   const st = pm.loadCanonicalState()          // null ⇒ triggers NOT evaluated
 *   const ev = st ? pm.evaluateTriggers(st) : null
 *   pm.taskStartRetrieval({ state: st, limit: 20 })
 *   pm.search({ text: 'P0', statuses: ['deferred'] })
 *   pm.promote(id, { approved: true, promotion_id, target, content })
 *   pm.reconcile()                              // index drift auto-repaired
 */

export const VERSION = '0.1.1'

export * from './model.ts'
export * from './storage.ts'
export * from './service.ts'