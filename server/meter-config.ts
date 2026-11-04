// 綁定正式 DB 的後台連線設定存取；規則與說明在 meter-config-core.ts。
import { db } from './shared.js'
import {
  type MeterEnv, type MeterProfile,
  loadMeterConfigFrom, saveMeterConfigValueTo, legacyUnclassifiedFrom, migrateMeterConfigEnvOn,
} from './meter-config-core.js'

export { type MeterEnv, type MeterProfile, METER_ENVS, parseMeterEnv, classifyMeterHost, classifyLegacySet, missingConfigMessage } from './meter-config-core.js'

export const loadMeterConfig = (env: MeterEnv, profile: MeterProfile) => loadMeterConfigFrom(db, env, profile)
export const saveMeterConfigValue = (env: MeterEnv, profile: MeterProfile, key: string, value: string) => saveMeterConfigValueTo(db, env, profile, key, value)
export const legacyUnclassified = (profile: MeterProfile) => legacyUnclassifiedFrom(db, profile)
export const migrateMeterConfigEnv = () => migrateMeterConfigEnvOn(db)
