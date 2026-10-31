import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Fingerprint, KeyRound, Loader2, LogIn } from 'lucide-react'
import { ApiError, errorMessage, login, safeRedirect } from '@/lib/api'
import { enrolWithCode, passkeysSupported, signInWithPasskey } from '@/lib/passkey'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { PasswordInput } from '@/components/password-input'
import { useT } from '@/lib/i18n'

type Values = { password: string }
// password -> passkey (registered) or enrol (first passkey, with a code from `ekip hub passkey add`)
type Step = 'password' | 'passkey' | 'enrol'

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
  enrolCode?: string
}

export function UserAuthForm({ className, redirectTo, enrolCode, ...props }: UserAuthFormProps) {
  const t = useT()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>('password')
  const [code, setCode] = useState(enrolCode ?? '')
  const [stepError, setStepError] = useState<string | null>(null)
  const formSchema = z.object({ password: z.string().min(1, t('Parolayı girin.')) })
  const form = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: { password: '' } })

  const done = () => {
    qc.clear()
    navigate({ to: safeRedirect(redirectTo), replace: true })
  }
  const stepMessage = (e: unknown) => {
    // the user closed the browser's passkey sheet, or it timed out
    if (e instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(e.name)) return t('Passkey işlemi iptal edildi veya zaman aşımına uğradı.')
    if (e instanceof DOMException && e.name === 'InvalidStateError') return t('Bu passkey zaten kayıtlı.')
    if (e instanceof ApiError && e.status === 401 && /password step/.test(e.message)) {
      setStep('password')
      return t('Giriş süresi doldu, parolayı yeniden girin.')
    }
    if (e instanceof ApiError && e.status === 401 && /enrolment code/.test(e.message)) return t('Kayıt kodu geçersiz, kullanılmış veya süresi dolmuş.')
    if (e instanceof ApiError && e.status === 401) return t('Passkey doğrulanamadı.')
    return errorMessage(e)
  }

  const passkey = useMutation({
    mutationFn: () => (step === 'enrol' ? enrolWithCode(code.trim()) : signInWithPasskey()),
    onMutate: () => setStepError(null),
    onSuccess: done,
    onError: (e) => setStepError(stepMessage(e)),
  })

  const mutation = useMutation({
    mutationFn: (v: Values) => login(v.password),
    onSuccess: (r) => {
      if (enrolCode) return setStep('enrol')
      if (r.next) return setStep(r.next)
      done()
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError && e.status === 401 ? t('Parola yanlış.') : errorMessage(e)
      form.setError('password', { message: msg })
      form.setFocus('password')
    },
  })

  if (step !== 'password') {
    const enrol = step === 'enrol'
    return (
      <form
        className={cn('grid gap-3', className)}
        onSubmit={(e) => {
          e.preventDefault()
          passkey.mutate()
        }}
      >
        <p className='text-sm text-muted-foreground'>
          {enrol
            ? t('Bu cihaza bir passkey kaydedin (Touch ID, iCloud Anahtar Zinciri veya güvenlik anahtarı). Kod, güvendiğiniz bilgisayarda ekip hub passkey add ile alınır.')
            : t('Parola doğru. Girişi passkey ile tamamlayın (Touch ID, iCloud Anahtar Zinciri veya güvenlik anahtarı).')}
        </p>
        {enrol && (
          <Input
            aria-label={t('Kayıt kodu')}
            autoComplete='one-time-code'
            autoFocus
            placeholder='ABCDE-FGHJK'
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        {!passkeysSupported() && (
          <p className='text-sm text-destructive'>{t('Bu tarayıcı passkey desteklemiyor.')}</p>
        )}
        {stepError && <p className='text-sm text-destructive'>{stepError}</p>}
        <Button className='mt-1' disabled={passkey.isPending || !passkeysSupported() || (enrol && !code.trim())}>
          {passkey.isPending ? <Loader2 className='animate-spin' /> : enrol ? <KeyRound /> : <Fingerprint />}
          {enrol ? t('Passkey kaydet') : t('Passkey ile devam et')}
        </Button>
        {!enrol && (
          <Button type='button' variant='ghost' size='sm' onClick={() => { setStepError(null); setStep('enrol') }}>
            {t('Kayıt kodum var (yeni cihaz)')}
          </Button>
        )}
      </form>
    )
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
        className={cn('grid gap-3', className)}
        {...props}
      >
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Parola')}</FormLabel>
              <FormControl>
                <PasswordInput autoComplete='current-password' autoFocus placeholder='••••••••••' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button className='mt-2' disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className='animate-spin' /> : <LogIn />}
          {t('Giriş yap')}
        </Button>
      </form>
    </Form>
  )
}
