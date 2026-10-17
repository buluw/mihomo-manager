import { useId, type ReactNode } from "react"
import { RefreshCw, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

export const updateActionsClassName = "mt-3.5 grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end md:[&>button]:min-w-34"
export const updateButtonClassName = "h-9 gap-1.5 px-2.5"

export function UpdateCard({ title, version, checking, checkDisabled, onCheck, previous, rollbackDisabled, onRollback, checkedAt, children }: {
  title: string; version: string; checking?: boolean; checkDisabled: boolean; onCheck?: () => void
  previous: string; rollbackDisabled: boolean; onRollback?: () => void; checkedAt?: string | null; children: ReactNode
}) {
  const titleId = useId()
  const checkedTime = checkedAt ? new Date(checkedAt) : null
  const validTime = checkedTime && Number.isFinite(checkedTime.getTime())
  return <section aria-labelledby={titleId} className="flex flex-col gap-2">
    <h2 id={titleId} className="text-[13px] font-medium">{title}</h2>
    <Card className="gap-0 rounded-xl py-0">
      <CardHeader className="flex flex-row items-center gap-2.5 px-3 py-4 md:px-[18px] md:py-[17px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <CardDescription>当前版本</CardDescription>
          <p className="text-2xl font-semibold tracking-tight wrap-anywhere">{version}</p>
        </div>
        <Button variant="outline" size="lg" className={updateButtonClassName + " min-w-24 max-md:min-w-24"} disabled={checkDisabled} onClick={onCheck}>
          {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}检查更新
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-col gap-3 px-3 py-3.5 md:px-[18px] md:pt-[15px] md:pb-[17px]">{children}</CardContent>
      <Separator />
      <CardFooter className="min-h-15 justify-between gap-2 px-3 py-2.5 md:px-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[13px]">上一可用版本</p>
          <CardDescription className="wrap-anywhere">{previous}</CardDescription>
        </div>
        <Button variant="outline" size="lg" className={updateButtonClassName + " min-w-19 max-md:min-w-19"} disabled={rollbackDisabled} onClick={onRollback}><RotateCcw data-icon="inline-start" />回退</Button>
      </CardFooter>
    </Card>
    {checkedAt !== undefined && <p className="mx-0.5 text-[11px] text-muted-foreground">上次检查：{validTime ? <time dateTime={checkedAt!}>{checkedTime.toLocaleString("zh-CN", { hour12: false })}</time> : "尚未检查"}</p>}
  </section>
}

export function UpdateCardStatus({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-7 items-center justify-between gap-2">
    <div role="status" className="flex min-w-0 items-center gap-2 text-[13px] font-medium">{icon}<span className="wrap-anywhere">{children}</span></div>
    {action}
  </div>
}
