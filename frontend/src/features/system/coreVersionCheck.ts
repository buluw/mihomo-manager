type VersionState = {
  checkState: "unchecked" | "checking" | "succeeded" | "failed"
  current: { version: string } | null
  latest: { version: string } | null
}

export function coreVersionConclusion(state: VersionState | null): string {
  if (!state || state.checkState === "unchecked") return "尚未检查更新"
  if (state.checkState === "checking") return "正在查询官方稳定版"
  if (state.checkState === "failed") return "版本检查失败，请重试"
  if (!state.current) return "当前版本未知，无法比较"
  const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(state.current.version)
  const latest = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(state.latest?.version ?? "")
  if (!current || !latest) return "版本格式不可比较，请核对版本信息"
  for (let index = 1; index <= 3; index++) {
    const left = BigInt(current[index]!)
    const right = BigInt(latest[index]!)
    if (left < right) return "发现新版本 " + state.latest!.version
    if (left > right) return "当前版本高于官方稳定版"
  }
  return "当前已是最新版本"
}
