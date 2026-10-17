import type { DirectDelayTestSettings } from "../api/configClient.ts"

export const directDelayPresets = [
  { value: "huawei", label: "华为", url: "http://connectivitycheck.platform.hicloud.com/generate_204" },
  { value: "xiaomi", label: "小米", url: "http://connect.rom.miui.com/generate_204" },
  { value: "vivo", label: "vivo", url: "http://wifi.vivo.com.cn/generate_204" },
  { value: "custom", label: "自定义", url: "" },
] as const

export const defaultDirectDelayTest: DirectDelayTestSettings = { version: 0, preset: "xiaomi" }

export function directDelayTestUrl(value = defaultDirectDelayTest) {
  return value.preset === "custom" ? value.url?.trim() ?? "" : directDelayPresets.find(item => item.value === value.preset)!.url
}

export function directDelayTestError(value: Pick<DirectDelayTestSettings, "preset" | "url">) {
  if (value.preset !== "custom") return null
  const text = value.url?.trim() ?? ""
  if (!text) return "请输入直连测速地址"
  try {
    const url = new URL(text)
    if (text.length > 2048 || /\s/.test(text) || !["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error()
    return null
  } catch { return "直连测速地址必须是有效的 HTTP 或 HTTPS URL" }
}
