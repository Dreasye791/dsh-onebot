/**
 * QQ 内置表情 id（OneBot face 段的 QSid）→ 中文名。
 *
 * 生成文件，勿手改：node scripts/gen-face-table.mjs
 * 数据源：NapCat 的 static/assets/qface-BZLvZXJ8.js（UTF-8）。
 * 覆盖 275 条（id 0–348）。
 * @module dsh-onebot/face-names
 */
export declare const FACE_NAMES: Record<string, string>;
