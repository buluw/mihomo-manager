import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { useDirtyGuard } from "@/hooks/useDirtyGuard"
import type { Notify } from "@/shared/types"
import { cleanCollectionLocation, collectionNavigationState, readCollectionTarget, type CollectionSource, type CollectionTarget } from "@/shared/collectionTarget"
import { CollectionView } from "./CollectionView"
import { ManagedCollectionWorkspace } from "./ManagedCollectionWorkspace"
import type { ProviderCategory } from "./collectionViewModel"
import { useProviderCollections } from "./useProviderCollections"
import { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"

let lastCollectionsCategory: ProviderCategory = "proxy"

export function Collections({ notify }: { notify: Notify }) {
  const location = useLocation()
  const navigate = useNavigate()
  const routeLocation = useRef(location)
  if (location.pathname === "/collections") routeLocation.current = location
  const target = readCollectionTarget(routeLocation.current)
  useEffect(() => {
    if (location.pathname !== "/collections" || !location.search) return
    const destination = cleanCollectionLocation(location)
    navigate(destination.pathname, { state: destination.state, replace: true })
  }, [location, navigate])
  return <CollectionWorkspacePage key={target.invalid ? "invalid" : target.source?.name ?? "runtime"} notify={notify} target={target} />
}

function CollectionWorkspacePage({ notify, target }: { notify: Notify; target: CollectionTarget }) {
  const navigate = useNavigate()
  const location = useLocation()
  const currentLocation = useRef(location)
  currentLocation.current = location
  const onSourceChange = useCallback((source: CollectionSource, item?: { category: ProviderCategory; name: string }) => {
    if (currentLocation.current.pathname !== "/collections") return
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.source = source.name
    state.collectionTarget.sha256 = source.sha256
    if (item) { state.collectionTarget.category = item.category; state.collectionTarget.collection = item.name; delete state.collectionTarget.repair }
    navigate("/collections", { state, replace: true })
  }, [navigate])
  const [category, setCategoryState] = useState<ProviderCategory>(() => target.category ?? lastCollectionsCategory)
  useEffect(() => {
    if (target.category) {
      lastCollectionsCategory = target.category
      setCategoryState(target.category)
    }
  }, [target.category])
  const setCategory = (next: ProviderCategory) => {
    lastCollectionsCategory = next
    setCategoryState(next)
  }
  const [inputDirty, setInputDirty] = useState(false)
  const workspace = useManagedProviderWorkspace(category, notify, { inputDirty,
    source: target.source, invalidSource: target.invalid, targetName: target.category === category ? target.name : null, onSourceChange })
  const runtime = useProviderCollections(notify, workspace.runtimeSource ? JSON.stringify(workspace.runtimeSource) : "")
  useDirtyGuard(inputDirty || workspace.dirty, workspace.busy)
  const refresh = useCallback(async () => {
    await Promise.all([workspace.refresh(), runtime.loadCategory("proxy"), runtime.loadCategory("rule")])
  }, [workspace.refresh, runtime.loadCategory])
  const refreshAfterApply = useCallback(async () => {
    await Promise.all([runtime.loadCategory("proxy"), runtime.loadCategory("rule")])
  }, [runtime.loadCategory])
  useRegisterPageRefresh(refresh)
  const switchCategory = (next: ProviderCategory) => {
    if (workspace.busy || inputDirty) { notify("请先保存或取消当前集合输入", "error"); return false }
    if (next === category) return true
    setCategory(next)
    if (target.source) {
      const state = collectionNavigationState(currentLocation.current)
      state.collectionTarget.category = next
      delete state.collectionTarget.collection
      delete state.collectionTarget.repair
      navigate("/collections", { state, replace: true })
    }
    return true
  }
  return <CollectionView
    sourceName={target.source ? `${target.source.name} · ${target.source.sha256.slice(0, 8)}` : workspace.snapshot?.name}
    status={workspace.identityStatus !== "ready" && !(workspace.identityStatus === "loading" && workspace.snapshot) ? workspace.message : workspace.dirty ? "未保存 · Core 尚未改变"
      : workspace.savedPending ? "已保存待应用 · Core 尚未改变" : target.source ? "集合来源：明确编辑配置" : "集合来源：最近成功加载配置"}>
    <ManagedCollectionWorkspace category={category} workspace={workspace} runtime={runtime}
      notify={notify} inputDirty={inputDirty} onInputDirtyChange={setInputDirty} onRefresh={refresh} onApplied={refreshAfterApply}
      target={target} onCategoryChange={switchCategory} />
  </CollectionView>
}
