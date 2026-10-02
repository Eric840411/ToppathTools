/**
 * 使用者手填的 Meegle 單號清單（TestCase 生成的參考單等）。前後端共用一份解析規則。
 * 接受：`15194994`、`#15194994`、Meegle 單子網址（…/detail/15194994）；逗號、頓號、空白、換行分隔。
 * 看不懂的不猜、不略過——回 invalid 讓畫面講清楚（CodeX：要掃描單號驗證、去重，不能還限定 Jira key）。
 */
export type ParsedRefs = { ids: string[]; invalid: string[] }

export function parseMeegleRefs(text: string): ParsedRefs {
  const ids: string[] = []
  const invalid: string[] = []
  for (const raw of String(text ?? '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)) {
    const url = /\/detail\/(\d{5,})(?:[/?#]|$)/.exec(raw)
    const plain = /^#?(\d{5,})$/.exec(raw)
    const id = url?.[1] ?? plain?.[1]
    if (!id) { invalid.push(raw); continue }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids, invalid }
}
