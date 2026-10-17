// 汇总跨功能模块共享的宽松 JSON 与通知函数类型。
export type Json = Record<string, any>;

export type Notify = (message: string, kind?: "ok" | "error") => void;
