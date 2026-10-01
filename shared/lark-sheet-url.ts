/**
 * Lark Sheet 網址 → spreadsheet token＋sheet id。純函式，前後端與測試共用這一份
 * （原本寫在 server/shared.ts，那支檔案一 import 就會開 DB，測試沒辦法直接用）。
 */
export function parseLarkSheetUrl(url: string): { spreadsheetToken: string; sheetId: string } {
  const tokenMatch = url.match(/\/sheets\/([A-Za-z0-9]+)/)
    ?? url.match(/\/wiki\/([A-Za-z0-9]+)/)
  const sheetMatch = url.match(/[?&]sheet=([A-Za-z0-9]+)/)
  return {
    spreadsheetToken: tokenMatch?.[1] ?? '',
    sheetId: sheetMatch?.[1] ?? '',
  }
}

/**
 * 來源 Sheet 的識別值：token＋sheet id，不是完整網址（CodeX review 0c30dde [P2]）。
 * 同一份 Sheet 的網址常帶不同尾巴（`&from=share`、參數順序不同），比完整網址的話防重複會被繞過、開出第二張單。
 * 解析不出 token 的（不是 Lark 網址）才退回原字串。
 */
export function sheetSourceKey(url: string): string {
  const { spreadsheetToken, sheetId } = parseLarkSheetUrl(url.trim())
  return spreadsheetToken ? `lark:${spreadsheetToken}:${sheetId}` : url.trim()
}
