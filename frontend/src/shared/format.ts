// 提供界面统一使用的字节单位格式化。
export function formatBytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.max(
    0,
    Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1),
  );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
