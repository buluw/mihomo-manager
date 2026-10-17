import test from "node:test"
import assert from "node:assert/strict"
import { coreVersionConclusion } from "../src/features/system/coreVersionCheck.ts"

test("version feedback uses successful stable comparison independently of file preparation", () => {
  const state = { checkState: "succeeded" as const, current: { version: "v1.19.31" }, latest: { version: "v1.19.32" } }
  assert.equal(coreVersionConclusion(state), "发现新版本 v1.19.32")
  assert.equal(coreVersionConclusion({ ...state, current: { version: "1.19.32" } }), "当前已是最新版本")
  assert.equal(coreVersionConclusion({ ...state, current: { version: "v1.20.0" } }), "当前版本高于官方稳定版")
  assert.equal(coreVersionConclusion({ ...state, current: { version: "alpha-abcdef" } }), "版本格式不可比较，请核对版本信息")
  assert.equal(coreVersionConclusion({ ...state, current: null }), "当前版本未知，无法比较")
  assert.equal(coreVersionConclusion({ ...state, checkState: "failed" }), "版本检查失败，请重试")
  assert.equal(coreVersionConclusion({ ...state, checkState: "checking" }), "正在查询官方稳定版")
  assert.equal(coreVersionConclusion({ ...state, checkState: "unchecked" }), "尚未检查更新")
})
