/** 语言设置值（"auto" = 跟随系统语言，见 index.ts 的 detectSystemLanguage） */
export type LangCode = "auto" | "zh-CN" | "en";

/** 实际生效的语言（"auto" 解析后的结果） */
export type Language = "zh-CN" | "en";

/** t(key, params) 的插值参数：{name} 会被替换为对应值 */
export type Params = Record<string, string | number>;

/** 字典：扁平 key → 文案。加语言 = 新增一个满足该形状的字典文件 + 在 index.ts 注册一行。 */
export type Dict = Record<string, string>;
