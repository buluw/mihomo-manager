import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pencil, Plus, Upload } from "lucide-react";

export function ConfigAddDialog({
  addOpen, setAddOpen, addMode, setAddMode, newName, setNewName,
  uploadName, setUploadName, uploadContent, uploadLabel, nameError, setNameError,
  chooseUpload, createDraft, uploadFile, creating
}: {
  addOpen: boolean
  setAddOpen: (open: boolean) => void
  addMode: "new" | "upload"
  setAddMode: (mode: "new" | "upload") => void
  newName: string
  setNewName: (name: string) => void
  uploadName: string
  setUploadName: (name: string) => void
  uploadContent: string | null
  uploadLabel: string
  nameError: string | null
  setNameError: (error: string | null) => void
  chooseUpload: (file: File | undefined) => Promise<void>
  createDraft: () => Promise<void>
  uploadFile: () => Promise<void>
  creating: boolean
}) {
  return (
    <Dialog
      open={addOpen}
      onOpenChange={(open) => {
        setAddOpen(open)
        if (!open) setNameError(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加配置</DialogTitle>
          <DialogDescription>
            新建空配置或上传已有 YAML。成功后只写入磁盘，不会加载 Controller。
          </DialogDescription>
        </DialogHeader>
        <Tabs value={addMode} onValueChange={(value) => {
          setAddMode(value as "new" | "upload")
          setNameError(null)
        }}>
          <TabsList className="w-full">
            <TabsTrigger value="new" className="flex-1">新建配置</TabsTrigger>
            <TabsTrigger value="upload" className="flex-1">上传文件</TabsTrigger>
          </TabsList>
        </Tabs>
        <FieldGroup>
          {addMode === "new" ? (
          <Field data-invalid={Boolean(nameError)}>
            <FieldLabel htmlFor="new-item-name">名称</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="new-item-name"
                value={newName}
                autoFocus
                autoComplete="off"
                maxLength={115}
                aria-invalid={Boolean(nameError)}
                onChange={(event) => {
                  setNewName(event.target.value)
                  if (nameError) setNameError(null)
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>.yaml</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldError>{nameError}</FieldError>
          </Field>
          ) : (
            <>
              <Field data-invalid={Boolean(nameError)}>
                <FieldLabel htmlFor="upload-config-file">YAML 文件</FieldLabel>
                <label className="flex min-h-20 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/20 px-4 text-sm text-muted-foreground hover:bg-muted/40"
                  onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length !== 1) { setNameError("主配置一次只能上传一个文件"); return } void chooseUpload(event.dataTransfer.files[0]) }}>
                  <Upload className="size-5" />
                  <span className="max-w-full truncate">{uploadLabel || "点击或拖入 .yaml 或 .yml 文件"}</span>
                  <input
                    id="upload-config-file"
                    type="file"
                    accept=".yaml,.yml,application/yaml,text/yaml"
                    className="sr-only"
                    onChange={(event) => void chooseUpload(event.target.files?.[0])}
                  />
                </label>
                {uploadContent != null && (
                  <InputGroup>
                    <InputGroupInput
                      value={uploadName}
                      aria-label="上传后的配置文件名"
                      onChange={(event) => {
                        setUploadName(event.target.value)
                        setNameError(null)
                      }}
                    />
                  </InputGroup>
                )}
                <FieldError>{nameError}</FieldError>
              </Field>
            </>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button
            className="min-w-20"
            disabled={
              creating ||
              (addMode === "new" ? !newName.trim() : uploadContent == null || !uploadName.trim())
            }
            onClick={() => void (addMode === "new" ? createDraft() : uploadFile())}
          >
            {creating ? <Spinner data-icon="inline-start" /> : addMode === "new" ? <Plus data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
            {addMode === "new" ? "创建配置" : "上传配置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConfigRenameDialog({
  renameOpen, setRenameOpen, renameSource, renameName, setRenameName, renameError, setRenameError, renameFile, renaming
}: {
  renameOpen: boolean
  setRenameOpen: (open: boolean) => void
  renameSource: string
  renameName: string
  setRenameName: (name: string) => void
  renameError: string | null
  setRenameError: (error: string | null) => void
  renameFile: () => Promise<void>
  renaming: boolean
}) {
  return (
    <Dialog open={renameOpen} onOpenChange={(open) => {
      setRenameOpen(open)
      if (!open) setRenameError(null)
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名配置</DialogTitle>
          <DialogDescription>目标文件：{renameSource}。重命名后保留当前编辑草稿，运行记录沿用既有来源。</DialogDescription>
        </DialogHeader>
        <Field data-invalid={Boolean(renameError)}>
          <FieldLabel htmlFor="rename-config-name">文件名</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="rename-config-name"
              value={renameName}
              autoFocus
              aria-invalid={Boolean(renameError)}
              onChange={(event) => {
                setRenameName(event.target.value)
                setRenameError(null)
              }}
            />
          </InputGroup>
          <FieldError>{renameError}</FieldError>
        </Field>
        <DialogFooter>
          <Button disabled={!renameName.trim() || renaming} onClick={() => void renameFile()}>
            {renaming ? <Spinner data-icon="inline-start" /> : <Pencil data-icon="inline-start" />}
            重命名
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
