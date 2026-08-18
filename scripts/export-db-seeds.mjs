/**
 * scripts/export-db-seeds.mjs
 *
 * Export current DB data to seed JSON files:
 *   server/machine-profiles.json  — machine_test_profiles table
 *   server/prompts.json           — gemini_prompts table
 *   server/config-templates.json  — config_templates table (OSM Config 比對模板)
 *
 * Run: node scripts/export-db-seeds.mjs
 *
 * After running, review the files and commit to Git.
 * On next server startup, INSERT OR IGNORE will seed missing rows automatically.
 */
import Database from 'better-sqlite3'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = join(__dirname, '..', 'server')
const db = new Database(join(SERVER_ROOT, 'data.db'), { readonly: true })

// ─── Machine Profiles ──────────────────────────────────────────────────────────
const profileRows = db.prepare('SELECT * FROM machine_test_profiles ORDER BY machineType').all()
const profiles = profileRows.map(r => ({
  machineType:       r.machineType,
  bonusAction:       r.bonusAction ?? 'auto_wait',
  touchPoints:       r.touchPoints       ? JSON.parse(r.touchPoints)       : [],
  clickTake:         !!r.clickTake,
  gmid:              r.gmid              ?? null,
  spinSelector:      r.spinSelector      ?? null,
  balanceSelector:   r.balanceSelector   ?? null,
  exitSelector:      r.exitSelector      ?? null,
  notes:             r.notes             ?? null,
  entryTouchPoints:  r.entryTouchPoints  ? JSON.parse(r.entryTouchPoints)  : [],
  entryTouchPoints2: r.entryTouchPoints2 ? JSON.parse(r.entryTouchPoints2) : [],
  ideckXpaths:       r.ideck_xpaths      ? JSON.parse(r.ideck_xpaths)      : [],
  audioConfig:       r.audioConfig       ? JSON.parse(r.audioConfig)       : null,
}))

const profilesPath = join(SERVER_ROOT, 'machine-profiles.json')
writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8')
console.log(`✅ Exported ${profiles.length} machine profiles → server/machine-profiles.json`)

// ─── Gemini Prompts ────────────────────────────────────────────────────────────
const promptRows = db.prepare('SELECT id, name, template, category FROM gemini_prompts ORDER BY id').all()
const promptsPath = join(SERVER_ROOT, 'prompts.json')
writeFileSync(promptsPath, JSON.stringify(promptRows, null, 2), 'utf-8')
console.log(`✅ Exported ${promptRows.length} prompts → server/prompts.json`)

// ─── Config Templates ──────────────────────────────────────────────────────────
const configTemplateRows = db.prepare('SELECT id, name, version, template, created_at FROM config_templates ORDER BY name').all()
const configTemplatesPath = join(SERVER_ROOT, 'config-templates.json')
writeFileSync(configTemplatesPath, JSON.stringify(configTemplateRows, null, 2), 'utf-8')
console.log(`✅ Exported ${configTemplateRows.length} config templates → server/config-templates.json`)

console.log('\nDone. Review the files and commit them to Git.')
db.close()
