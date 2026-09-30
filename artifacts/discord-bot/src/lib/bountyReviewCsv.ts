export type ReviewImportRow = { userId: string; roleIds: string[] };

/** CSV columns: user_id,role_ids; multiple role IDs in one cell are separated by |. */
export function parseBountyReviewCsv(text: string): ReviewImportRow[] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  let closed = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && cell === "" && !closed) {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim()); cell = ""; closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = ""; closed = false;
    } else if (closed || char === '"') {
      throw new Error(`CSV ${rows.length + 1}行目の引用符が不正です。`);
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSVの引用符が閉じられていません。");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows[0]?.join(",").toLowerCase() !== "user_id,role_ids") {
    throw new Error("CSVの先頭行は user_id,role_ids にしてください。");
  }
  if (rows.length < 2 || rows.length > 501) throw new Error("CSVは対象者1〜500人を指定してください。");
  const seen = new Set<string>();
  return rows.slice(1).map((columns, index) => {
    const line = index + 2;
    if (columns.length !== 2 || !/^\d{17,20}$/.test(columns[0] ?? "")) {
      throw new Error(`CSV ${line}行目のユーザーIDまたは列数が不正です。`);
    }
    const userId = columns[0]!;
    if (seen.has(userId)) throw new Error(`CSV ${line}行目: ユーザーID ${userId} が重複しています。`);
    seen.add(userId);
    const roleIds = (columns[1] ?? "").split("|").map((value) => value.trim());
    if (roleIds.some((id) => !/^\d{17,20}$/.test(id)) || new Set(roleIds).size !== roleIds.length) {
      throw new Error(`CSV ${line}行目のロールIDが不正または重複しています。`);
    }
    return { userId, roleIds };
  });
}