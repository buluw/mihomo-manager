import { useCallback, useEffect, useRef, useState } from "react"
import { CloudDownload, FileInput, FileText } from "lucide-react"
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router"

import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { useUiState } from "@/app/state/uiState"
import { WorkspacePage } from "@/components/layout/page-frame"
import { ResourceWorkspace, ResourceWorkspaceLayout } from "@/components/patterns/resource-workspace"
import {
  WorkspaceBody,
  WorkspaceCategoryTabs,
} from "@/components/patterns/workspace"
import { useDirtyGuard } from "@/hooks/useDirtyGuard"
import type { Notify } from "@/shared/types"
import { readConfigFile, type ConfigSnapshot, type ManagedProviderFile, type ProviderFileIssue } from "@/api/configClient"
import { cleanCollectionLocation, collectionEditLocation, collectionSourceMatches, configEditLocation, configRenameLocation, readCollectionTarget, type CollectionSource } from "@/shared/collectionTarget"

import { ConfigFileWorkspace } from "./ConfigFileWorkspace"
import { MergeConfigWorkspace } from "./MergeConfigWorkspace"
import { SubscriptionWorkspace } from "./SubscriptionWorkspace"
import { useConfigWorkspace } from "./useConfigWorkspace"
import { useSubscriptionWorkspace } from "./useSubscriptionWorkspace"
import { ConfigCategoryPicker, ConfigDetailHeader, type ConfigSection } from "./ConfigMobileNavigation"

export function ConfigCenterPage({ notify }: { notify: Notify }) {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const currentLocation = useRef(location)
  currentLocation.current = location
  const navigate = useNavigate()
  const initialSource = useRef(readCollectionTarget(location).source)
  const previousLocation = useRef(location)
  const [section, setSection] = useState<ConfigSection>("files")
  const [mobileDetailOpen, setMobileDetailOpen] = useState(initialSource.current !== null)
  const openDetail = useCallback(() => setMobileDetailOpen(true), [])
  const backToList = useCallback(() => setMobileDetailOpen(false), [])
  const internalSourceNavigation = useRef<CollectionSource | null>(null)
  const [sharedProviderFiles, setSharedProviderFiles] = useState<ManagedProviderFile[] | null>(null)
  const [mergeGuard, setMergeGuard] = useState({ dirty: false, pendingWrite: false })
  const onActiveRename = useCallback((from: CollectionSource, to: CollectionSource) => {
    const current = currentLocation.current
    if (current.pathname !== "/config-center" || !collectionSourceMatches(readCollectionTarget(current).source, from)) return
    const destination = configRenameLocation(current, from, to)
    internalSourceNavigation.current = to
    navigate(destination.pathname, { state: destination.state, replace: true })
  }, [navigate])
  const config = useConfigWorkspace(notify, "edit", initialSource.current, onActiveRename)
  const subscription = useSubscriptionWorkspace(
    notify,
    config.applyExternalSnapshot,
    sharedProviderFiles,
    setSharedProviderFiles,
  )
  const { askConfirm } = useUiState()

  useEffect(() => {
    if (location.pathname !== "/config-center" || searchParams.get("view") === "runtime") return
    const source = readCollectionTarget(location).source
    let explicitTarget = false
    if (location.key !== previousLocation.current.key) {
      previousLocation.current = location
      const internal = collectionSourceMatches(source, internalSourceNavigation.current)
      internalSourceNavigation.current = null
      if (!internal) {
        setSection("files")
        setMobileDetailOpen(source !== null)
        explicitTarget = source !== null
      }
    }
    if (location.search) {
      const destination = cleanCollectionLocation(location)
      navigate(destination.pathname, { state: destination.state, replace: true })
      return
    }
    if (explicitTarget && source && source.name !== config.activeName) {
      void config.load(false, source.name)
      return
    }
    if (config.busy || !config.activeName || !config.sha256 || config.contentState !== "ready") return
    const current = { name: config.activeName, sha256: config.sha256 }
    if (!collectionSourceMatches(current, source)) {
      const destination = configEditLocation(current)
      internalSourceNavigation.current = current
      navigate(destination.pathname, { state: destination.state, replace: true })
    }
  }, [config.activeName, config.sha256, config.contentState, config.busy, config.load, location, searchParams, navigate])

  const openCollections = async (snapshot?: ConfigSnapshot, item?: ProviderFileIssue) => {
    if (!snapshot && config.dirty) {
      if (!await askConfirm({ title: "保存配置并编辑集合？", message: "先保存当前配置草稿，再管理其中的集合；保存后待应用。", confirmLabel: "保存并继续", cancelLabel: "继续编辑" })) return
      await config.saveConfig()
    }
    const source = snapshot ?? config.collectionSource()
    if (!source) return
    try {
      const fresh = await readConfigFile(source.name)
      if (fresh.sha256 !== source.sha256) { notify("配置版本已变化，请重新读取后编辑集合", "error"); return }
      const target = item?.status === "missing" ? fresh.providerIssues?.find((issue) => issue.category === item.category && issue.name === item.name && issue.status === "missing")
        : fresh.providerIssues?.find((issue) => issue.status === "missing")
      if (!target) { notify("该配置没有缺失集合，请重新读取配置状态"); return }
      const destination = collectionEditLocation(source, target ? { category: target.category, name: target.name, repair: target.status === "missing" } : undefined, location.key)
      navigate(destination.pathname, { state: destination.state })
    } catch { notify("无法确认集合编辑目标，请重新读取配置", "error") }
  }

  const currentDirty =
    section === "files" ? config.dirty : section === "subscriptions" ? subscription.dirty : mergeGuard.dirty
  const workspaceBusy = config.busy !== null || subscription.busy !== null
  const pendingWrite =
    config.busy === "save" ||
    config.busy === "apply" ||
    config.mutation !== null ||
    subscription.busy === "save" ||
    subscription.updatingId !== null ||
    subscription.busy === "delete" || mergeGuard.pendingWrite
  useDirtyGuard(currentDirty, pendingWrite)

  const refreshCurrentSection = useCallback(
    async () => {
      if (workspaceBusy) return
      if (section === "files") await config.load(true)
      else await subscription.load(subscription.activeId ?? undefined, section === "subscriptions")
    },
    [
      config.busy,
      config.load,
      section,
      subscription.activeId,
      subscription.load,
      workspaceBusy,
    ]
  )
  useRegisterPageRefresh(refreshCurrentSection)

  const requestSection = async (next: ConfigSection) => {
    if (pendingWrite) return false
    if (next === section) return true
    if (
      currentDirty &&
      !(await askConfirm({
        title: "放弃未保存更改？",
        message: "继续切换会丢弃当前本地修改。",
        confirmLabel: "放弃并切换",
        danger: true,
      }))
    )
      return false
    if (section === "files") config.resetToSaved()
    else if (section === "subscriptions") subscription.resetToSaved()
    setMobileDetailOpen(false)
    setSection(next)
    return true
  }

  const subscriptionCount =
    subscription.items.length + (subscription.newDraft ? 1 : 0)
  const categoryTabs = <WorkspaceCategoryTabs layout="list" value={section} disabled={pendingWrite} onValueChange={value => void requestSection(value as ConfigSection)} items={[{ value: "files", label: "配置文件", icon: FileText }, { value: "subscriptions", label: "订阅配置", icon: CloudDownload }, { value: "merge", label: "代理集提取", icon: FileInput }]} />
  const mobileListTitle = <ConfigCategoryPicker section={section} disabled={pendingWrite} onChoose={requestSection} />

  if (location.pathname === "/config-center" && searchParams.get("view") === "runtime") return <Navigate to="/runtime-config" replace />

  return (
    <WorkspacePage className="grid-rows-[minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <ResourceWorkspaceLayout>
      <ConfigFileWorkspace onBack={backToList} workspace={config} onOpenCollections={openCollections} mobileListTitle={mobileListTitle} onOpenDetail={openDetail}>
        {(configView) => (
          <SubscriptionWorkspace
            workspace={subscription}
            count={subscriptionCount}
            mobileListTitle={mobileListTitle}
            onOpenDetail={openDetail}
          >
            {(subscriptionView) => {
              if (section === "merge") {
                return <WorkspaceBody><MergeConfigWorkspace resourcesHeader={categoryTabs} subscriptions={subscription} configFiles={config.files} notify={notify} providerFiles={sharedProviderFiles} onProviderFilesCommit={setSharedProviderFiles} loadedName={config.loadedName} onGuardChange={setMergeGuard} mobileListTitle={mobileListTitle} mobileDetailOpen={mobileDetailOpen} onOpenDetail={openDetail} onBack={backToList} /></WorkspaceBody>
              }
              const activeView = section === "files" ? configView : subscriptionView

              return (
                <>
                  <WorkspaceBody>
                    <ResourceWorkspace
                      idPrefix="config-center"
                      resourcesHeader={categoryTabs}
                      resources={activeView.resources}
                      mobileResources={activeView.mobileResources}
                      toolbar={activeView.toolbar}
                      status={activeView.status}
                      mobileNavigation={{ detailOpen: mobileDetailOpen, header: section === "files" ? undefined : <ConfigDetailHeader title={subscription.form.name || "新订阅"} onBack={backToList} /> }}
                      resizeHandleLabel="调整资源列表宽度"
                    >
                      {activeView.editor}
                    </ResourceWorkspace>
                  </WorkspaceBody>

                  {activeView.deleteDialog}
                  {activeView.addDialog}
                </>
              )
            }}
          </SubscriptionWorkspace>
        )}
      </ConfigFileWorkspace>
      </ResourceWorkspaceLayout>
    </WorkspacePage>
  )
}
