import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { useDirtyGuard } from "@/hooks/useDirtyGuard"
import type { Notify } from "@/shared/types"
import { cleanCollectionLocation, collectionNavigationState, collectionSelectionLocation, configEditLocation, openCollectionWorkspace, readCollectionTarget, readCollectionWorkspace, resolveCommittedCollectionSource, type CollectionSource, type CollectionTarget, type CollectionWorkspaceNavigation } from "@/shared/collectionTarget"
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
  const navigation = readCollectionWorkspace(routeLocation.current)
  useEffect(() => {
    if (location.pathname !== "/collections") return
    const destination = cleanCollectionLocation(location)
    if (!location.search && destination.state.collectionTarget.entry) return
    const current = readCollectionWorkspace(location)
    Object.assign(destination.state.collectionTarget, { entry: current.entry, view: current.view })
    destination.state.collectionTarget.category ||= lastCollectionsCategory
    if (current.returnView) destination.state.collectionTarget.returnView = current.returnView
    navigate(destination.pathname, { state: destination.state, replace: true })
  }, [location, navigate])
  return <CollectionWorkspacePage key={target.invalid ? "invalid" : target.source?.name ?? "runtime"} notify={notify} target={target} navigation={navigation} />
}

function CollectionWorkspacePage({ notify, target, navigation }: { notify: Notify; target: CollectionTarget; navigation: CollectionWorkspaceNavigation }) {
  const navigate = useNavigate()
  const location = useLocation()
  const activePath = useRef(location.pathname)
  activePath.current = location.pathname
  const currentLocation = useRef(location)
  if (location.pathname === "/collections") currentLocation.current = location
  const latestSource = useRef(target.source)
  const acceptedVersions = useRef(new Set(target.source ? [target.source.sha256] : []))
  const source = resolveCommittedCollectionSource(target.source, latestSource.current, acceptedVersions.current)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const onSourceChange = useCallback((next: CollectionSource, item?: { category: ProviderCategory; name: string }) => {
    if (sourceRef.current?.name === next.name) acceptedVersions.current.add(sourceRef.current.sha256)
    acceptedVersions.current.add(next.sha256)
    latestSource.current = next
    if (activePath.current !== "/collections") return
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.source = next.name
    state.collectionTarget.sha256 = next.sha256
    if (item) { state.collectionTarget.category = item.category; state.collectionTarget.collection = item.name; delete state.collectionTarget.repair }
    navigate("/collections", { state, replace: true })
  }, [navigate])
  useEffect(() => {
    if (!source || source.sha256 === target.source?.sha256 || location.pathname !== "/collections") return
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.sha256 = source.sha256
    navigate("/collections", { state, replace: true })
  }, [source?.sha256, target.source?.sha256, location.pathname, navigate])
  const [initialCategory] = useState(lastCollectionsCategory)
  const category = target.category ?? initialCategory
  const [inputDirty, setInputDirty] = useState(false)
  const [discardInputVersion, setDiscardInputVersion] = useState(0)
  const discardLocalInput = useCallback(() => { setDiscardInputVersion(version => version + 1); setInputDirty(false) }, [])
  const workspace = useManagedProviderWorkspace(category, notify, { inputDirty,
    source, invalidSource: target.invalid, targetName: target.category === category ? target.name : null, onSourceChange })
  const runtime = useProviderCollections(notify, workspace.runtimeSource ? JSON.stringify(workspace.runtimeSource) : "")
  useDirtyGuard(workspace.dirty, workspace.busy, { dirty: inputDirty, onDiscard: discardLocalInput })
  const refresh = useCallback(async () => {
    await Promise.all([workspace.refresh(), runtime.loadCategory("proxy"), runtime.loadCategory("rule")])
  }, [workspace.refresh, runtime.loadCategory])
  const refreshAfterApply = useCallback(async () => {
    await Promise.all([runtime.loadCategory("proxy"), runtime.loadCategory("rule")])
  }, [runtime.loadCategory])
  useRegisterPageRefresh(refresh)
  useEffect(() => {
    if (location.pathname !== "/collections" || target.name || !workspace.active || workspace.identityStatus !== "ready") return
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.category = category
    state.collectionTarget.collection = workspace.active.name
    navigate("/collections", { state, replace: true })
  }, [category, target.name, workspace.active?.name, workspace.identityStatus, location.pathname, navigate])
  const switchCategory = (next: ProviderCategory) => {
    if (workspace.busy || inputDirty) { notify("请先确认或取消当前集合输入", "error"); return false }
    if (next === category) return true
    lastCollectionsCategory = next
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.category = next
    delete state.collectionTarget.collection
    delete state.collectionTarget.repair
    navigate("/collections", { state, replace: true })
    return true
  }
  const back = () => {
    if (navigation.returnKey) { navigate(-1); return }
    if (navigation.returnView === "config" && source) {
      const destination = configEditLocation(workspace.snapshot ?? source)
      navigate(destination.pathname, { state: destination.state })
      return
    }
    const state = collectionNavigationState(currentLocation.current)
    state.collectionTarget.view = "list"
    delete state.collectionTarget.returnView
    delete state.collectionTarget.returnKey
    navigate("/collections", { state, replace: true })
  }
  const openManagement = () => {
    if (navigation.returnView === "manage" && navigation.returnKey) { back(); return }
    const destination = openCollectionWorkspace(currentLocation.current, "manage", crypto.getRandomValues(new Uint32Array(4)).join("-"))
    navigate(destination.pathname, { state: destination.state })
  }
  const selectCollection = async (name: string, open: boolean) => {
    const selected = collectionSelectionLocation(currentLocation.current, { category, name })
    if (open && navigation.view !== "editor") {
      const destination = openCollectionWorkspace(selected, "editor", crypto.getRandomValues(new Uint32Array(4)).join("-"))
      await navigate(selected.pathname, { state: selected.state, replace: true })
      navigate(destination.pathname, { state: destination.state })
    } else {
      navigate(selected.pathname, { state: selected.state, replace: true })
    }
  }
  return <CollectionView
    sourceName={source ? source.name + " · " + source.sha256.slice(0, 8) : workspace.snapshot?.name}
    status={workspace.identityStatus !== "ready" && !(workspace.identityStatus === "loading" && workspace.snapshot) ? workspace.message : workspace.dirty ? "未保存 · Core 尚未改变"
      : workspace.savedPending ? "已保存待应用 · Core 尚未改变" : source ? "集合来源：明确编辑配置" : "集合来源：最近成功加载配置"}>
    <ManagedCollectionWorkspace category={category} workspace={workspace} runtime={runtime}
      notify={notify} inputDirty={inputDirty} onInputDirtyChange={setInputDirty} onRefresh={refresh} onApplied={refreshAfterApply}
      target={{ ...target, source }} navigation={navigation} discardInputVersion={discardInputVersion}
      onCategoryChange={switchCategory} onSelectCollection={selectCollection} onOpenManagement={openManagement} onBack={back}
      onReturnConfig={() => { if (source) { const destination = configEditLocation(workspace.snapshot ?? source); navigate(destination.pathname, { state: destination.state }) } }} onEndTarget={() => navigate("/collections")} />
  </CollectionView>
}
