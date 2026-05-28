# TestCase 斷點續跑設計文件

> 版本：v1.0（2026-05-28）  
> 討論來源：Claude + Codex 協作討論（三輪 challenge）

---

## 問題背景

TestCase 生成功能（LarkPage）目前在生成完成後才能寫入 Bitable。若中途中斷，使用者需要重新跑全部流程，浪費 LLM 成本，且可能輸出不一致的結果。

---

## 設計目標

1. 中斷後可從上次進度續跑，不重跑已完成的批次
2. Bitable 寫入不重複，即使在超時、中斷情況下也不產生重複 TestCase
3. 並行 resume 不互相干擾

---

## 資料模型

### `generation_jobs`（任務層，只標階段）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `source_hash` | TEXT | 輸入來源 hash，偵測輸入是否變更 |
| `prompt_version` | TEXT | 使用的 prompt 版本 |
| `status` | TEXT | 見下方狀態機 |
| `last_checkpoint` | TEXT | 最後一次有效 checkpoint 描述 |
| `created_at` | INTEGER | |
| `updated_at` | INTEGER | |

#### Job 狀態機

```
pending → running → generated → committing → completed
                                     ↓
                                   failed
```

| 狀態 | 說明 |
|------|------|
| `pending` | 任務建立，尚未開始 |
| `running` | LLM 生成中 |
| `generated` | 所有 draft 已寫入 DB（durable），尚未寫 Bitable |
| `committing` | 正在批次寫入 Bitable |
| `completed` | 全部寫入完成 |
| `failed` | 某步驟失敗，可續跑 |

> Job 狀態只決定「現在在哪個階段」，續跑的實際邏輯依 per-testcase 狀態決定。

---

### `generated_test_cases`（結果層，控制去重與續跑）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `job_id` | TEXT FK | 對應 generation_jobs.id |
| `seq_in_job` | INTEGER | 在 job 中的固定序號（建立時一次性分配，不依排序）|
| `input_ref` | TEXT | 對應輸入項的穩定 hash |
| `idempotency_key` | TEXT UNIQUE | `hash(job_id + stable_input_hash + seq_in_job)` |
| `gen_status` | TEXT | `pending / generating / done / gen_failed` |
| `commit_status` | TEXT | `pending / in_progress / committed / commit_failed` |
| `bitable_record_id` | TEXT | 寫入 Bitable 後取得 |
| `content` | TEXT | 生成的 TestCase JSON |
| `error_message` | TEXT | 失敗原因 |
| `gen_started_at` | INTEGER | 用於 TTL 計算 |
| `commit_started_at` | INTEGER | 用於 TTL 計算 |

---

## Resume 邏輯

### 生成階段（LLM）

| `gen_status` | 行為 |
|------|------|
| `done` | 跳過，直接進 commit 流程 |
| `generating` 且未超 TTL（30s）| 跳過（其他 worker 正在跑）|
| `generating` 且超 TTL | 視為 `gen_failed`，重新生成（允許 LLM 輸出不同）|
| `gen_failed` | 重跑 |
| `pending` | 開始生成 |

### Commit 階段（Bitable 寫入）

| `commit_status` | 行為 |
|------|------|
| `committed` | 跳過 |
| `in_progress` 且未超 TTL（30s）| 跳過（其他 worker 在寫）|
| `in_progress` 且超 TTL | 用 `idempotency_key` 查 Bitable 補回狀態（見下方）|
| `commit_failed` | 重試 |
| `pending` | 開始寫入 |

### Bitable 補回流程（超時後 resume）

以 `idempotency_key` 查詢 Bitable 的決策表：

| 查詢結果 | DB 狀態轉移 | 說明 |
|---------|-----------|------|
| 零筆（HTTP 200, records=[]）| 寫入 Bitable → 取回 `bitable_record_id` → `commit_status = committed` | 確認未寫入，安全寫 |
| 一筆 | 補回 `bitable_record_id` → `commit_status = committed`，不重寫 | Bitable 已有，補回本地狀態 |
| 多筆 | `commit_status = commit_failed`，停下等人工 | Bitable 唯一性已破壞，不可任選 |
| 查詢失敗（timeout / error）| 保持 `commit_status = in_progress`，下次 resume 重試 | 不當零筆，不寫入 |

**「Bitable 寫入成功但 DB 更新失敗」的 resume 決策（P2）：**
下次 resume 時 `commit_status` 仍為 `in_progress`，走上表流程查 Bitable：
- 查到一筆 → 代表上次寫入已成功，補回 `bitable_record_id`，標記 `committed`
- 不重新寫入，不永久卡住

---

## Checkpoint 更新順序

```
1. LLM 生成結果寫入 DB（gen_status = done）← durable 先
2. 更新 job status = generated（若全部 done）
3. 開始批次寫入 Bitable（commit_status = in_progress）
4. 寫入成功 → 存 bitable_record_id，commit_status = committed
5. 全部 committed → job status = completed
```

> Checkpoint 更新必須晚於 durable draft 寫入，早於外部 commit，或由 idempotency 補償。

---

## 並發規則

- 同一 `idempotency_key` 進入 `in_progress` → 其他 worker 跳過，不等、不重複
- `in_progress` 超過 30s 未更新 → 視為過期，下次 resume 可重新認領（見原子認領規則）
- `source_hash` 不符（輸入已變更）→ 提示使用者選擇「繼續舊 job」或「重新建立新 job」

### 原子認領規則（Codex P1）

認領過期 item 必須使用 **條件式 UPDATE**，不可先 SELECT 再 UPDATE：

```sql
-- 生成認領
UPDATE generated_test_cases
SET gen_status = 'generating', gen_started_at = now()
WHERE id = ? 
  AND gen_status = 'gen_failed'  -- 或 gen_status='generating' AND gen_started_at < expires_at
```

```sql
-- commit 認領
UPDATE generated_test_cases
SET commit_status = 'in_progress', commit_started_at = now()
WHERE id = ?
  AND (commit_status = 'pending'
    OR (commit_status = 'in_progress' AND commit_started_at < ?))
```

**判斷 `affected rows`**：若為 0，代表其他 worker 搶先，本 worker 跳過。

**TTL 語義**：`expires_at` 不是欄位，是計算值 `commit_started_at < now() - 30s`（SQLite：`commit_started_at < strftime('%s','now') - 30`）。不另存 `commit_expires_at` 欄位，以 TTL 常數計算為準。

### Bitable 查詢失敗不可當零筆（Codex P1）

查詢 `idempotency_key` 時若 API 回傳錯誤或 timeout：
- **不可視為零筆** → 不可直接寫入（可能已寫入只是查不到）
- 正確行為：保持 `commit_status = in_progress`，等下次 resume 時重試查詢
- 只有明確的「空結果（HTTP 200，records=[]）」才視為零筆，允許寫入

### 不變條件（硬性規則，Codex P1）

以下兩點為整個設計的前提，**任何實作都不可違反**：

1. **`generated_test_cases.idempotency_key` 必須有 DB UNIQUE constraint** — 確保同一 job 不會產生重複 key，DB 層阻擋雙寫
2. **Bitable 端 idempotency 欄位不可被人工修改** — 若欄位被改，查不到已寫入的記錄，補回機制失效，會重複寫入

### 殘餘風險說明（Bitable 端無法完全防重）

**DB fencing（`commit_lease_token`）保護本地狀態，但無法防止 Bitable 端重複寫入。**

原因：若舊 worker 的 lease 過期、新 worker 已重新認領，舊 worker 仍可能在 Bitable 完成寫入但 DB mark 失敗；此時新 worker 查詢 Bitable 若因延遲一致性看不到舊 record，仍可能再 create 一筆。

**補償流程（偵測為主，不可完全防止）：**
- commit 前後都以 `_idempotency_key` 查詢 Bitable
- 查到多筆時 → `commit_status = commit_failed`，標記 job 為 `conflict`，停止自動處理
- 由人工或定期清理任務 reconcile Bitable 重複 record
- 根本解決需 Bitable 提供原子 upsert 或唯一欄位 API（目前不支援）

---

## 最低驗證清單

- [ ] 中途故意中斷，resume 後不重跑已 `gen_status = done` 的批次
- [ ] 模擬 Bitable 寫入 timeout，resume 後用 `idempotency_key` 補回而非重複寫入
- [ ] 兩個 worker 同時 resume，確認不重複寫入
- [ ] `source_hash` 變更後有提示，不靜默沿用舊 job
- [ ] `npx tsc --noEmit` 無錯誤，`npm run build` 成功

---

## 尚未決定的事項

- `idempotency_key` 在 Bitable 端存入哪個欄位（備注 or 獨立欄位）
- TTL 30s 是否合適（取決於 Bitable API 實際 response time）
- 過期 job 的 lifecycle 策略（幾天後自動清除？）
