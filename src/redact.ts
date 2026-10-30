/**
 * 出站文本的本机路径脱敏。
 *
 * 背景：模型读文件（read_image / 追加写入等）必须拿到绝对路径，但它常把路径
 * 顺手复述进回复，群里就泄露了目录结构与用户名。工具返回值不能改（模型仍要用），
 * 所以只在**要发出去的文字**里统一替换成占位符。
 *
 * 只处理「看起来像本机绝对路径」的三类形态，不碰相对路径与 URL：
 *   - 盘符：`D:\foo\bar`、`C:/foo/bar`
 *   - UNC：`\\server\share\...`
 *   - 长路径前缀：`\\?\D:\...`
 */

/**
 * 路径的合法终止符：空白、中文标点、引号、**左右括号**、书名号、尖括号。
 *
 * 为什么左右括号都要列：`/workspace` 的输出形如
 * `1. C:\tmp\onebot-test-x（1 会话） ← 当前`。只列 `）` 而不列 `（` 时，
 * 正则会把 `（1` 一起当成路径吃掉 —— 用户看到的是
 * `1. <本机路径> 会话） ← 当前`，计数被吞、语义被破坏。
 * 左括号（全角 `（`、书名号 `《`、引号 `「『`）与右括号同理都是路径**外**的字符。
 */
const STOP = '\\s"\'，。；：！？、（）)《》【】「」『』\\]}>'

/** `\\?\D:\...`，必须排在 UNC 之前匹配，否则会被当成 `\\?`。 */
const LONG_PATH = new RegExp(`\\\\\\\\\\?\\\\[^${STOP}]+`, 'g')
/** `\\server\share\...` */
const UNC_PATH = new RegExp(`\\\\\\\\[^${STOP}]+`, 'g')
/** `D:\...` / `C:/...`；前置断言排除 `https://` 里 `s:/` 这类误判。 */
const DRIVE_PATH = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${STOP}]*`, 'g')

/** 替换后的占位符；保持可读，便于模型/用户理解「这里原本是本机路径」。 */
export const LOCAL_PATH_PLACEHOLDER = '<本机路径>'

/**
 * 把文本里的本机绝对路径替换为占位符。
 * @param text - 待发送的正文。
 * @returns 替换后的文本，以及命中次数（0 表示未改动）。
 */
export function redactLocalPaths(text: string): { text: string; count: number } {
  if (text === '') return { text, count: 0 }

  let count = 0
  const mask = (): string => {
    count += 1
    return LOCAL_PATH_PLACEHOLDER
  }

  const masked = text
    .replace(LONG_PATH, mask)
    .replace(UNC_PATH, mask)
    .replace(DRIVE_PATH, mask)

  return { text: masked, count }
}
