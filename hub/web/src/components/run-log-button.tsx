import { useState } from 'react'
import { FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

export function RunLogButton({ id, failed = false }: { id: string; failed?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function show() {
    setOpen(true)
    if (log || loading) return
    setLoading(true); setError('')
    try { setLog((await api<{ log: string }>(`/api/runs/${encodeURIComponent(id)}/log`)).log) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  return <>
    <Button size='sm' variant={failed ? 'destructive' : 'outline'} onClick={show} aria-label={failed ? t('hata logu') : t('Log')}>
      <FileText aria-hidden='true' />{failed ? t('hata logu') : t('Log')}
    </Button>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side='right' className='w-full sm:max-w-3xl'>
        <SheetHeader><SheetTitle>{t('Çalıştırma logu')}</SheetTitle><SheetDescription className='font-mono text-xs'>{id}</SheetDescription></SheetHeader>
        {loading ? <p className='px-4 text-sm text-muted-foreground'>{t('Yükleniyor…')}</p> : error ? <p role='alert' className='px-4 text-sm text-destructive'>{error}</p> : <pre className='mx-4 mt-2 max-h-[calc(100vh-9rem)] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap'>{log}</pre>}
      </SheetContent>
    </Sheet>
  </>
}
