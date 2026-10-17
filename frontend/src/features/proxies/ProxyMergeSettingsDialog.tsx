import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  Plus,
  GripVertical,
  Search,
  Split,
  X,
} from "lucide-react";

import type { ProxyAddresses, ProxyMergeSettings } from "@/api/configClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import {
  addMergeGroupMembers,
  applyAutomaticRecognition,
  automaticRecognitionFeedback,
  assignedIdentityKeys,
  beginProxyMergeDrag,
  beginProxyMergeGroupDrag,
  cancelProxyMergeDrag,
  createManualMergeGroup,
  createProxyMergeGroupId,
  mergeGroupAvailability,
  endProxyMergeDrag,
  previewProxyMergeDrag,
  previewProxyMergeDragToUnmerged,
  proxyIdentityKey,
  proxyMergeGroupsForDisplay,
  removeMergeGroupMember,
  renameMergeGroup,
  splitMergeGroup,
  suggestMergeName,
  type AvailableProxyNode,
  type ProxyMergeDragSession,
} from "./proxyMergeSettings";

function DraggableNode({ node, children }: { node: AvailableProxyNode; children: React.ReactNode }) {
  const key = proxyIdentityKey(node);
  const drag = useDraggable({ id: `node:${key}`, data: { dragKind: "member", node } });
  return <div ref={drag.setNodeRef} className={cn("flex items-center transition-[opacity,transform]", drag.isDragging && "invisible")}>
    <Button type="button" variant="ghost" size="icon-sm" className="touch-none cursor-grab active:cursor-grabbing" ref={drag.setActivatorNodeRef} {...drag.listeners} {...drag.attributes} aria-label={`拖动 ${node.name}`}><GripVertical /></Button>
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
}

function DraggableMember({ node, groupId, index, children }: { node: AvailableProxyNode; groupId: string; index: number; children: React.ReactNode }) {
  const key = proxyIdentityKey(node);
  const drag = useSortable({ id: `member:${key}`, data: { dragKind: "member", node, groupId, index } });
  return <span ref={drag.setNodeRef} style={{ transform: CSS.Transform.toString(drag.transform), transition: drag.transition }} className={cn("inline-flex max-w-full items-center", drag.isDragging && "invisible")}>
    <Button type="button" variant="ghost" size="icon-sm" className="size-6 touch-none cursor-grab active:cursor-grabbing" ref={drag.setActivatorNodeRef} {...drag.listeners} {...drag.attributes} aria-label={`拖动 ${node.name}`}><GripVertical /></Button>
    {children}
  </span>;
}

function DropGroup({ id, children }: { id: string; children: React.ReactNode }) {
  const drop = useDroppable({ id: `group:${id}`, data: { dropKind: "group", groupId: id } });
  return <div ref={drop.setNodeRef} className={cn("rounded-md border p-3 transition-colors", drop.isOver && "border-primary bg-primary/5 ring-2 ring-primary/30")}>{children}</div>;
}

function DropUnmerged({ children }: { children: React.ReactNode }) {
  const drop = useDroppable({ id: "unmerged", data: { dropKind: "unmerged" } });
  return <section ref={drop.setNodeRef} className={cn(
    "flex min-w-0 flex-col border-b p-4 transition-colors md:min-h-0 md:border-r md:border-b-0",
    drop.isOver && "bg-primary/5 ring-2 ring-inset ring-primary/30",
  )}>{children}</section>;
}

function DraggableGroupHandle({ group }: { group: ProxyMergeSettings["groups"][number] }) {
  const drag = useDraggable({
    id: `merge-group:${group.id}`,
    data: { dragKind: "group", groupId: group.id, group },
  });
  return <span ref={drag.setNodeRef} className="inline-flex">
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="touch-none cursor-grab active:cursor-grabbing"
      ref={drag.setActivatorNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      aria-label={`拖动整个 ${group.displayName || "未命名合并"}`}
    ><GripVertical /></Button>
  </span>;
}

type DraggedItem =
  | { kind: "member"; node: AvailableProxyNode }
  | { kind: "group"; group: ProxyMergeSettings["groups"][number] };

type DragTarget =
  | { kind: "group"; groupId: string; index?: number; member?: AvailableProxyNode }
  | { kind: "unmerged" }
  | null;

export function ProxyMergeSettingsDialog({
  open,
  onOpenChange,
  draft,
  onDraftChange,
  available,
  nodesState,
  addresses,
  readAddresses,
  loading,
  saving,
  sessionLoaded,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ProxyMergeSettings;
  onDraftChange: (settings: ProxyMergeSettings) => void;
  available: AvailableProxyNode[];
  nodesState: "loading" | "ready" | "error";
  addresses: ProxyAddresses;
  readAddresses: () => Promise<ProxyAddresses | null>;
  loading: boolean;
  saving: boolean;
  sessionLoaded: boolean;
  error: string | null;
  onSave: () => void;
}) {
  const [search, setSearch] = useState("");
  const [mobileViewport, setMobileViewport] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const update = () => setMobileViewport(window.matchMedia("(min-width: 768px)").matches
      ? null : { height: viewport.height, top: viewport.offsetTop });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);
  const [recognitionMessage, setRecognitionMessage] = useState("");
  const [recognizing, setRecognizing] = useState(false);
  const [showAbsentGroups, setShowAbsentGroups] = useState(false);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const nodesReady = nodesState === "ready";
  const recognitionContext = useRef({ open, draft, available });
  recognitionContext.current = { open, draft, available };
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [displayName, setDisplayName] = useState("");
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);
  const [dragSession, setDragSession] = useState<ProxyMergeDragSession | null>(null);
  const dragSessionRef = useRef<ProxyMergeDragSession | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }),
  );
  const displayedDraft = dragSession?.preview ?? draft;
  const assigned = useMemo(() => assignedIdentityKeys(displayedDraft), [displayedDraft]);
  const draggedKeys = useMemo(() => new Set(
    draggedItem?.kind === "member"
      ? [proxyIdentityKey(draggedItem.node)]
      : draggedItem?.group.members.map(proxyIdentityKey) ?? [],
  ), [draggedItem]);
  const unmerged = useMemo(() => nodesReady ? available.filter((node) => (
    !draggedKeys.has(proxyIdentityKey(node)) && !assigned.has(proxyIdentityKey(node))
  )) : [], [assigned, available, draggedKeys, nodesReady]);
  // Keep source groups in place during a drag, even when its only present member is lifted.
  const absentGroupIds = new Set(proxyMergeGroupsForDisplay(draft, nodesReady ? available : null).absent.map((group) => group.id));
  const currentGroups = displayedDraft.groups.filter((group) => !absentGroupIds.has(group.id));
  const absentGroups = displayedDraft.groups.filter((group) => absentGroupIds.has(group.id));
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return query
      ? unmerged.filter((node) => `${node.name} ${node.provider} ${node.protocol}`.toLocaleLowerCase("zh-CN").includes(query))
      : unmerged;
  }, [search, unmerged]);
  const selected = useMemo(
    () => unmerged.filter((node) => selectedKeys.has(proxyIdentityKey(node))),
    [selectedKeys, unmerged],
  );

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedKeys(new Set());
      setDisplayName("");
      setRecognitionMessage("");
      setShowAbsentGroups(false);
      setExpandedMembers(new Set());
    }
  }, [open]);

  useEffect(() => {
    setSelectedKeys((current) => new Set([...current].filter((key) => unmerged.some((node) => proxyIdentityKey(node) === key))));
  }, [unmerged]);

  useEffect(() => {
    setDisplayName(suggestMergeName(selected, addresses));
  }, [addresses, selected]);

  const toggle = (key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const clearSelection = () => setSelectedKeys(new Set());
  const invalidGroups = draft.groups.some((group) => group.members.length < 2);
  const publishDragSession = (session: ProxyMergeDragSession | null) => {
    if (dragSessionRef.current === session) return;
    dragSessionRef.current = session;
    setDragSession(session);
  };
  const dragTarget = (event: DragOverEvent | DragEndEvent): DragTarget => {
    const data = event.over?.data.current as {
      dropKind?: string;
      groupId?: string;
      index?: number;
      node?: AvailableProxyNode;
    } | undefined;
    if (data?.dropKind === "unmerged" || event.over?.id === "unmerged") return { kind: "unmerged" };
    if (data?.groupId) return { kind: "group", groupId: data.groupId, index: data.index, member: data.node };
    const target = String(event.over?.id || "");
    return target.startsWith("group:") ? { kind: "group", groupId: target.slice(6), index: undefined } : null;
  };
  const previewForTarget = (session: ProxyMergeDragSession, target: DragTarget) => {
    if (target?.kind === "unmerged") return previewProxyMergeDragToUnmerged(session);
    return previewProxyMergeDrag(
      session,
      target?.kind === "group" ? target.groupId : null,
      target?.kind === "group" ? target.index : undefined,
      target?.kind === "group" ? target.member : undefined,
    );
  };
  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as {
      dragKind?: string;
      node?: AvailableProxyNode;
      groupId?: string;
      group?: ProxyMergeSettings["groups"][number];
    } | undefined;
    if (data?.dragKind === "group" && data.groupId && data.group) {
      const session = beginProxyMergeGroupDrag(draft, data.groupId);
      if (!session) return;
      setDraggedItem({ kind: "group", group: data.group });
      publishDragSession(session);
      return;
    }
    if (!data?.node) return;
    setDraggedItem({ kind: "member", node: data.node });
    publishDragSession(beginProxyMergeDrag(draft, data.node));
  };
  const onDragOver = (event: DragOverEvent) => {
    const session = dragSessionRef.current;
    const target = dragTarget(event);
    if (!session) return;
    publishDragSession(previewForTarget(session, target));
  };
  const onDragCancel = () => {
    const session = dragSessionRef.current;
    if (session) cancelProxyMergeDrag(session);
    publishDragSession(null);
    setDraggedItem(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    let session = dragSessionRef.current;
    const target = dragTarget(event);
    if (session) session = previewForTarget(session, target);
    if (session) onDraftChange(endProxyMergeDrag(session));
    publishDragSession(null);
    setDraggedItem(null);
    const node = event.active.data.current?.node as AvailableProxyNode | undefined;
    if (!node || !session?.valid) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      next.delete(proxyIdentityKey(node));
      return next;
    });
  };

  const renderGroup = (group: ProxyMergeSettings["groups"][number], absent = false) => {
    const members = mergeGroupAvailability(group, available);
    const present = members.filter((member) => member.available);
    const missing = members.filter((member) => !member.available);
    const expanded = expandedMembers.has(group.id);
    const shown = !nodesReady || absent ? members : present;
    const collapsedMembers = nodesReady && !absent ? missing : [];
    const rendered = [...shown, ...(expanded ? collapsedMembers : [])];
    const renderMember = (member: typeof members[number]) => (
      <DraggableMember key={proxyIdentityKey(member)} groupId={group.id} index={member.index} node={{ provider: member.provider, name: member.name, protocol: available.find((node) => proxyIdentityKey(node) === proxyIdentityKey(member))?.protocol || "未知" }}>
        <Badge variant={nodesReady && member.available ? "secondary" : "outline"} className="h-auto min-h-5 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere">
          <span className="min-w-0 flex-1">{member.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-1"
            onClick={() => onDraftChange(removeMergeGroupMember(draft, group.id, member))}
            aria-label={`从 ${group.displayName} 移除 ${member.name}`}
          ><X /></Button>
        </Badge>
      </DraggableMember>
    );
    return <DropGroup key={group.id} id={group.id}>
      <div className="flex min-w-0 items-center gap-2">
        <DraggableGroupHandle group={group} />
        <Input maxLength={120} value={group.displayName} onChange={(event) => onDraftChange(renameMergeGroup(draft, group.id, event.target.value))} aria-label="合并机器名称" />
        <Badge variant="outline" className="shrink-0">{group.source === "manual" ? "人工" : "自动"}</Badge>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => onDraftChange(splitMergeGroup(draft, group.id))} aria-label={`拆分 ${group.displayName || "未命名合并"}`} />}><Split /></TooltipTrigger><TooltipContent>拆分</TooltipContent></Tooltip>
      </div>
      {nodesReady && present.length === 1 && <FieldDescription className="mt-2">当前仅1个节点</FieldDescription>}
      <SortableContext items={rendered.map((member) => `member:${proxyIdentityKey(member)}`)}>
        <div className="mt-2 flex flex-wrap gap-1.5">{shown.map(renderMember)}</div>
        {collapsedMembers.length > 0 && <Collapsible open={expanded} onOpenChange={(open) => setExpandedMembers((current) => {
          const next = new Set(current);
          if (open) next.add(group.id); else next.delete(group.id);
          return next;
        })}>
          <FieldDescription className="mt-2">
            <CollapsibleTrigger className="inline-flex items-center gap-1">
              <ChevronDown className="size-3" />另有 {collapsedMembers.length} 个节点未出现
            </CollapsibleTrigger>
          </FieldDescription>
          <CollapsibleContent><div className="mt-2 flex flex-wrap gap-1.5">{collapsedMembers.map(renderMember)}</div></CollapsibleContent>
        </Collapsible>}
      </SortableContext>
      <Button variant="outline" size="sm" className="mt-2" disabled={!selected.length} onClick={() => {
        onDraftChange(addMergeGroupMembers(draft, group.id, selected));
        clearSelection();
      }}><Plus data-icon="inline-start" />添加所选节点</Button>
    </DropGroup>;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={mobileViewport ? { height: mobileViewport.height - 16, maxHeight: mobileViewport.height - 16, top: mobileViewport.top + 8, translate: "-50% 0" } : undefined} className="flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-6xl flex-col gap-3 overflow-hidden p-0 md:h-[min(760px,calc(100dvh-2rem))] md:max-w-6xl">
        <DialogHeader className="shrink-0 px-4 pt-4 pr-12">
          <DialogTitle>合并设置</DialogTitle>
          <DialogDescription>设置在局域网设备间共享，只改变管理器中的节点显示。{addresses.source ? `识别来源：最近成功加载 ${addresses.source.name} 的生成文件。` : "识别来源未知。"}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" className="mx-4 w-auto">
            <AlertCircle />
            <AlertTitle>设置未保存</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!nodesReady && <Alert className="mx-4 w-auto">
          {nodesState === "loading" ? <Spinner /> : <AlertCircle />}
          <AlertTitle>{nodesState === "loading" ? "正在读取节点列表" : "节点列表读取失败"}</AlertTitle>
          <AlertDescription>暂不判断哪些节点未出现，合并记录与草稿已保留。</AlertDescription>
        </Alert>}
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragCancel={onDragCancel} onDragEnd={onDragEnd}>
        <div className={cn(
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain border-y md:grid md:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.5fr)] md:grid-rows-1 md:overflow-hidden",
          loading && "pointer-events-none opacity-60",
        )}>
          <DropUnmerged>
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-medium">未合并节点</h3>
              <Badge variant="secondary">{unmerged.length}</Badge>
            </div>
            <InputGroup className="mb-3">
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、来源或协议" />
            </InputGroup>
            <div className="rounded-md border md:min-h-0 md:flex-1 md:overflow-y-auto md:[scrollbar-gutter:stable]">
              <FieldGroup data-slot="checkbox-group" className="gap-0 p-1">
                {filtered.length ? filtered.map((node) => {
                  const key = proxyIdentityKey(node);
                  const inputId = `merge-node-${encodeURIComponent(key)}`;
                  return <DraggableNode key={key} node={node}>
                    <Field key={key} orientation="horizontal" className="rounded-sm px-2 py-2 hover:bg-accent/45">
                      <Checkbox id={inputId} checked={selectedKeys.has(key)} onCheckedChange={(checked) => toggle(key, checked === true)} />
                      <FieldLabel htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                        <span className="shrink-0 text-muted-foreground">{node.protocol}</span>
                      </FieldLabel>
                    </Field>
                  </DraggableNode>;
                }) : <p className="p-4 text-center text-muted-foreground">{nodesReady ? "没有可选节点" : "节点列表暂不可用"}</p>}
              </FieldGroup>
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={async () => {
                setRecognizing(true);
                try {
                  const fresh = await readAddresses();
                  const current = recognitionContext.current;
                  if (!current.open) return;
                  if (current.draft !== draft || current.available !== available) {
                    setRecognitionMessage("节点或合并草稿已变化，请重新识别");
                    return;
                  }
                  if (!fresh?.source) {
                    setRecognitionMessage("节点来源无法确认，请选择配置并成功加载后重试");
                    return;
                  }
                  if (fresh.source.loadVersion !== addresses.source?.loadVersion) {
                    setRecognitionMessage("配置来源已变化，请刷新节点列表后重新识别");
                    return;
                  }
                  const next = applyAutomaticRecognition(draft, fresh, available, createProxyMergeGroupId);
                  onDraftChange(next);
                  setRecognitionMessage(automaticRecognitionFeedback(draft, next, fresh, available));
                } finally { setRecognizing(false); }
              }}
              disabled={loading || saving || recognizing || !nodesReady}
            >
              {recognizing ? <Spinner data-icon="inline-start" /> : <Bot data-icon="inline-start" />}
              自动识别
            </Button>
            {recognitionMessage && <Alert className="mt-2"><AlertDescription>{recognitionMessage}</AlertDescription></Alert>}
          </DropUnmerged>
          <section className="flex min-w-0 flex-col p-4 md:min-h-0 md:overflow-hidden">
            <FieldGroup className="shrink-0">
              <Field data-invalid={selected.length > 0 && selected.length < 2}>
                <FieldTitle>合并预览</FieldTitle>
                <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5">
                  {selected.length ? selected.map((node) => <Badge key={proxyIdentityKey(node)} variant="secondary" className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere">{node.protocol} · {node.name}</Badge>) : <span className="text-muted-foreground">至少选择两个节点</span>}
                </div>
                <FieldError>{selected.length > 0 && selected.length < 2 ? "人工合并至少需要两个节点" : null}</FieldError>
              </Field>
              <Field orientation="responsive">
                <FieldLabel htmlFor="merge-display-name">名称</FieldLabel>
                <Input id="merge-display-name" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="留空时显示当前节点名" />
                <Button
                  onClick={() => {
                    onDraftChange(createManualMergeGroup(draft, createProxyMergeGroupId(), displayName, selected));
                    clearSelection();
                  }}
                  disabled={selected.length < 2}
                >
                  <Plus data-icon="inline-start" />
                  加入列表
                </Button>
              </Field>
            </FieldGroup>
            <Separator className="my-4" />
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium">已合并机器</h3>
              <Badge variant="secondary">{currentGroups.length}</Badge>
            </div>
            <div className="md:min-h-0 md:flex-1 md:overflow-y-auto md:[scrollbar-gutter:stable]">
              <div className="flex flex-col gap-2 md:pr-4">
                {currentGroups.map((group) => renderGroup(group))}
                {currentGroups.length === 0 && <p className="py-8 text-center text-muted-foreground">{absentGroups.length ? "当前没有出现的合并组" : "尚未设置合并机器"}</p>}
                {absentGroups.length > 0 && <Collapsible open={showAbsentGroups} onOpenChange={setShowAbsentGroups}>
                  <CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-start" />}>
                    <ChevronDown data-icon="inline-start" />当前未出现的合并组（{absentGroups.length}）
                  </CollapsibleTrigger>
                  <CollapsibleContent><div className="mt-2 flex flex-col gap-2">{absentGroups.map((group) => renderGroup(group, true))}</div></CollapsibleContent>
                </Collapsible>}
              </div>
            </div>
          </section>
        </div>
        {typeof document !== "undefined" ? createPortal(
          <DragOverlay dropAnimation={{ duration: 150, easing: "ease" }}>
            {draggedItem?.kind === "member" ? (
              <div className="flex max-w-xs items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
                <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{draggedItem.node.name}</span>
                <span className="shrink-0 text-muted-foreground">{draggedItem.node.protocol}</span>
              </div>
            ) : draggedItem?.kind === "group" ? (
              <div className="max-w-sm rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
                <div className="flex items-center gap-2 font-medium"><GripVertical className="size-4" />{draggedItem.group.displayName}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {draggedItem.group.members.map((member) => <Badge key={proxyIdentityKey(member)} variant="secondary">{member.name}</Badge>)}
                </div>
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        ) : null}
        </DndContext>
        <DialogFooter className="shrink-0 flex-row justify-end px-4 pb-[max(1rem,env(safe-area-inset-bottom))] [&>button]:min-h-11 [&>button]:flex-1 md:[&>button]:min-h-0 md:[&>button]:flex-none">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={onSave} disabled={saving || loading || !sessionLoaded || invalidGroups}>
            {saving && <Spinner data-icon="inline-start" />}
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
