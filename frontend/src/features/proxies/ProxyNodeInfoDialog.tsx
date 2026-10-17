import { AlertTriangle, MapPinned } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import type { useProxyNodeInfo } from "./useProxyNodeInfo";

type Workspace = ReturnType<typeof useProxyNodeInfo>;

export function ProxyNodeInfoDialog({ workspace }: { workspace: Workspace }) {
  return (
    <Dialog open={workspace.open} onOpenChange={workspace.changeOpen}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>节点信息</DialogTitle>
          <DialogDescription>人工地区在局域网设备间共享。识别结果先预览，保存后才切回自动；取消保留已保存地区。</DialogDescription>
        </DialogHeader>
        {workspace.error && <Alert variant="destructive"><AlertTriangle /><AlertTitle>未保存</AlertTitle><AlertDescription>{workspace.error}</AlertDescription></Alert>}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="proxy-node-name">当前节点</FieldLabel>
              <Input id="proxy-node-name" value={workspace.selected?.name ?? ""} readOnly placeholder="无法确定当前节点" />
            </Field>
            <Field>
              <FieldLabel htmlFor="proxy-node-server">Server</FieldLabel>
              <Input id="proxy-node-server" value={workspace.server} readOnly placeholder="无法读取" />
              <FieldDescription>{workspace.addressSource ? `地址来源：最近成功加载 ${workspace.addressSource} 的生成文件；不代表核心持续运行身份` : "地址来源未知"}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="proxy-node-region">地区</FieldLabel>
              <Input id="proxy-node-region" value={workspace.region} maxLength={160} onChange={(event) => workspace.setRegion(event.target.value)} placeholder="自动识别" disabled={workspace.saving} />
              <FieldDescription>人工地区在所有局域网设备间共享，并优先于自动识别。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>识别地区</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={!workspace.selected || workspace.saving || Boolean(workspace.recognizing)} onClick={() => void workspace.recognizeIpApi()}>{workspace.recognizing === "ip-api" ? <Spinner data-icon="inline-start" /> : <MapPinned data-icon="inline-start" />}ip-api.com</Button>
              </div>
            </Field>
          </FieldGroup>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => workspace.changeOpen(false)} disabled={workspace.saving}>取消</Button>
          <Button onClick={() => void workspace.save()} disabled={workspace.loading || workspace.saving || Boolean(workspace.recognizing) || !workspace.sessionLoaded || !workspace.selected}>
            {workspace.saving && <Spinner data-icon="inline-start" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
