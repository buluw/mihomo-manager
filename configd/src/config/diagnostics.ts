import { parseDocument } from "yaml";

export interface ConfigDiagnostic {
  code: string;
  message: string;
  path?: Array<string | number>;
}

// Output is untrusted and may contain credentials, URLs or entire provider bodies.
// Only fixed explanations and numeric indexes can leave this boundary.
export function coreDiagnostics(output: string, content?: string): ConfigDiagnostic[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (/`use` or `proxies` missing/.test(clean)) return [{ code: "empty_proxy_group", message: "代理组缺少 use 或 proxies；请为该组保留至少一个来源。" }];
  if (/proxy group\[\d+\].*not found/.test(clean)) return [{ code: "group_reference_missing", message: "代理组引用的节点或集合不存在；请检查 proxies 和 use。" }];
  if (/proxy group.*unsupported type/.test(clean)) return [{ code: "group_type", message: "代理组类型不受当前 Mihomo 支持。" }];
  if (/proxy group.*format error/.test(clean)) return [{ code: "group_format", message: "代理组字段格式错误；请检查 name、type 及列表字段。" }];
  if (/duplicate name/.test(clean)) return [{ code: "duplicate_name", message: "节点、代理组或监听器存在重复名称。" }];
  if (/(?:^|\n)(?:time="[^"\r\n]*" level=error msg=")?(?:loop is detected in ProxyGroup, please check following ProxyGroups: \[|sub-rule error: circular references \[)/.test(clean)) return [{ code: "circular_reference", message: "配置包含循环引用；请检查代理组或子规则。" }];
  if (/rules\[\d+\].*rule set .*not found/.test(clean)) {
    const diagnostic: ConfigDiagnostic = { code: "rule_provider_missing", message: "规则引用的 rule-providers 集合不存在。" };
    // Match the exact validated rule before exposing its index. Never return log text.
    if (content !== undefined) {
      try {
        const document = parseDocument(content);
        const source = document.errors.length ? null : document.toJS();
        for (const line of clean.split(/\r?\n/)) {
          const logged = line.match(/^time="[^"\r\n]*" level=error msg=(".*")$/);
          const message: string = logged ? JSON.parse(logged[1]!) : line;
          const match = message.match(/^rules\[(\d+)\] \[(.*)\] error: rule set \[(.*)\] not found$/);
          if (!match) continue;
          const index = Number(match[1]);
          const rule = Array.isArray(source?.rules) ? source.rules[index] : null;
          const parts = typeof rule === "string" ? rule.split(",").map((part) => part.trim()) : [];
          if (Number.isSafeInteger(index) && typeof rule === "string" && rule.trim() === match[2] &&
            parts[0] === "RULE-SET" && parts[1] === match[3] &&
            !Object.hasOwn(source?.["rule-providers"] ?? {}, parts[1]!)) {
            diagnostic.path = ["rules", index];
            break;
          }
        }
      } catch { /* Uncertain source positions remain unlocated. */ }
    }
    return [diagnostic];
  }
  if (/rules\[\d+\].*proxy .*not found/.test(clean)) return [{ code: "rule_target_missing", message: "规则引用的代理目标不存在。" }];
  if (/rules\[\d+\].*(format invalid|error:)/.test(clean)) return [{ code: "invalid_rule", message: "规则格式或参数无效；请检查规则类型、参数和目标。" }];
  if (/parse (proxy|rule) provider .*error:/.test(clean)) return [{ code: "invalid_provider", message: "集合声明或集合正文校验失败；请检查类型、格式和内容。" }];
  if (/proxy \d+:/.test(clean)) return [{ code: "invalid_proxy", message: "节点参数校验失败；请检查节点类型和必填字段。" }];
  if (/(?:^|[\s"])yaml:|unmarshal/.test(clean)) return [{ code: "yaml_type", message: "YAML 语法或字段类型不符合 Mihomo 要求。" }];
  if (/dns.*(error|invalid)|nameserver.*(error|invalid)/i.test(clean)) return [{ code: "invalid_dns", message: "DNS 配置或 nameserver 参数无效。" }];
  return [{ code: "core_validation_failed", message: "Mihomo 校验失败；未能安全提取具体原因，请检查配置及集合内容。" }];
}
