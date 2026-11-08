import { KpTicketError } from "@workspace/db";

export interface KpBusinessDay {
  date: string;
  start: Date;
  end: Date;
  label: string;
}

/** The latest opening date: before 18:00 JST, use yesterday (also during closed hours). */
export function latestKpBusinessDate(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  if (jst.getUTCHours() < 18) jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

/** Half-open interval [18:00 JST, following 10:00 JST), based on payment completion time. */
export function kpBusinessDay(date = latestKpBusinessDate()): KpBusinessDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new KpTicketError("営業日は YYYY-MM-DD 形式で入力してください（例: 2026-11-08）。");
  }
  const start = new Date(`${date}T18:00:00+09:00`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
    throw new KpTicketError("存在する日付を YYYY-MM-DD 形式で入力してください。");
  }
  const end = new Date(start.getTime() + 16 * 60 * 60_000);
  return { date, start, end, label: `${date} 18:00 ～ ${end.toISOString().slice(0, 10)} 10:00（日本時間・終了時刻を含まない）` };
}
