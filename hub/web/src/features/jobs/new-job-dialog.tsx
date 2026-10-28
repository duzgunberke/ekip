import { useEffect } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/api'
import { useCreateJob, useProjects, useStatus } from '@/hooks/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

const schema = z.object({
  project: z.string().min(1, 'Bir proje seçin.'),
  task: z
    .string()
    .trim()
    .min(1, 'Görevi yazın.')
    .max(50_000, 'Görev en fazla 50.000 karakter olabilir.'),
  via: z.enum(['auto', 'copilot', 'free']),
  push: z.boolean(),
})
type Values = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  project?: string
}

export function NewJobDialog({ open, onOpenChange, project }: Props) {
  const navigate = useNavigate()
  const projects = useProjects()
  const status = useStatus()
  const create = useCreateJob()
  const copilot = !!status.data?.github.copilot

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { project: project ?? '', task: '', via: 'auto', push: true },
  })

  useEffect(() => {
    if (open) {
      form.reset({ project: project ?? '', task: '', via: 'auto', push: true })
      create.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])

  const onSubmit = (v: Values) =>
    create.mutate(v, {
      onSuccess: (job) => {
        onOpenChange(false)
        toast.success('İş kuyruğa eklendi', { description: `${job.project} · ${job.id}` })
        navigate({ to: '/isler/$id', params: { id: job.id } })
      },
      onError: (e) => form.setError('root', { message: errorMessage(e) }),
    })

  const names = (projects.data ?? []).map((p) => p.name)

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className='sm:max-w-xl'>
        <DialogHeader className='text-start'>
          <DialogTitle>Yeni iş</DialogTitle>
          <DialogDescription>
            Hub projeyi klonlar, ayrı bir dalda çalıştırır ve isterseniz dalı GitHub'a gönderir.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form id='new-job-form' onSubmit={form.handleSubmit(onSubmit)} className='grid gap-4'>
            <FormField
              control={form.control}
              name='project'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Proje</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue
                          placeholder={projects.isLoading ? 'Yükleniyor…' : 'Proje seçin'}
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {names.length === 0 && (
                        <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                          Kayıtlı proje yok.
                        </div>
                      )}
                      {names.map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='task'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Görev</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={6}
                      className='max-h-72 min-h-32 resize-y'
                      placeholder="Örn. README'ye kurulum bölümü ekle"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>İlk satır işin başlığı olarak görünür.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormField
                control={form.control}
                name='via'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Model yolu</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value='auto'>Otomatik</SelectItem>
                        <SelectItem value='copilot' disabled={!copilot}>
                          Copilot{!copilot && ' (kapalı)'}
                        </SelectItem>
                        <SelectItem value='free'>Ücretsiz havuz</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {copilot
                        ? 'Otomatik: önce Copilot, olmazsa ücretsiz havuz.'
                        : "Copilot için hub'da COPILOT_GITHUB_TOKEN gerekli."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='push'
                render={({ field }) => (
                  <FormItem className='flex flex-row items-start justify-between gap-3 rounded-lg border p-3 sm:mt-5.5'>
                    <div className='grid gap-1'>
                      <FormLabel>Dalı gönder (push)</FormLabel>
                      <FormDescription>Değişiklik varsa dal GitHub'a gönderilir.</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            {form.formState.errors.root && (
              <p role='alert' className='text-sm text-destructive'>
                {form.formState.errors.root.message}
              </p>
            )}
          </form>
        </Form>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Vazgeç
          </Button>
          <Button type='submit' form='new-job-form' disabled={create.isPending}>
            {create.isPending ? <Loader2 className='animate-spin' /> : <Send />}
            Kuyruğa ekle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
