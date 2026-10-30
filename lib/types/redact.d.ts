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
/** 替换后的占位符；保持可读，便于模型/用户理解「这里原本是本机路径」。 */
export declare const LOCAL_PATH_PLACEHOLDER = "<\u672C\u673A\u8DEF\u5F84>";
/**
 * 把文本里的本机绝对路径替换为占位符。
 * @param text - 待发送的正文。
 * @returns 替换后的文本，以及命中次数（0 表示未改动）。
 */
export declare function redactLocalPaths(text: string): {
    text: string;
    count: number;
};
