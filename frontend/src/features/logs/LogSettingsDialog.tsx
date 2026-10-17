import { FormEvent, useEffect, useState } from "react";
import { Save } from "lucide-react";

import type { LogSettings } from "@/api/logClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const retentionItems = [
  { value: "1", label: "1 天" },
  { value: "7", label: "1 周" },
  { value: "30", label: "30 天" },
  { value: "custom", label: "自定义" },
];

export function LogSettingsDialog({
  settings,
  busy,
  loading,
  open,
  onOpenChange,
  onSave,
}: {
  settings: LogSettings;
  busy: boolean;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (retentionDays: number) => void;
}) {
  const initialPreset = [1, 7, 30].includes(settings.retentionDays) ? String(settings.retentionDays) : "custom";
  const [preset, setPreset] = useState(initialPreset);
  const [customDays, setCustomDays] = useState(String(settings.retentionDays));
  useEffect(() => {
    if (!open) return;
    setPreset([1, 7, 30].includes(settings.retentionDays) ? String(settings.retentionDays) : "custom");
    setCustomDays(String(settings.retentionDays));
  }, [open, settings.retentionDays]);
  useEffect(() => { if (preset !== "custom") setCustomDays(preset); }, [preset]);
  const days = Number(customDays);
  const valid = Number.isSafeInteger(days) && days >= 1 && days <= 3650;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy && !loading) onSave(days);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent showCloseButton={!busy}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>日志保留设置</DialogTitle>
            <DialogDescription>设置历史日志的保留时间，不影响实时日志显示。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="retention-preset">保留时间</Label>
            <Select items={retentionItems} value={preset} onValueChange={(value) => value && setPreset(String(value))}>
              <SelectTrigger id="retention-preset" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {retentionItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" && (
            <div className="grid gap-1.5">
              <Label htmlFor="retention-days">自定义天数</Label>
              <Input id="retention-days" type="number" min={1} max={3650} step={1} value={customDays} onChange={(event) => setCustomDays(event.target.value)} />
              <p className="text-[11px] text-muted-foreground">范围 1-3650 天</p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
            <Button type="submit" disabled={!valid || busy || loading}><Save />{loading ? "正在读取" : busy ? "正在保存" : "保存"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
