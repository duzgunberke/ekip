import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, LogIn } from 'lucide-react'
import { ApiError, errorMessage, login, safeRedirect } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { PasswordInput } from '@/components/password-input'

const formSchema = z.object({
  password: z.string().min(1, 'Parolayı girin.'),
})
type Values = z.infer<typeof formSchema>

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({ className, redirectTo, ...props }: UserAuthFormProps) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const form = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: { password: '' } })

  const mutation = useMutation({
    mutationFn: (v: Values) => login(v.password),
    onSuccess: () => {
      qc.clear()
      navigate({ to: safeRedirect(redirectTo), replace: true })
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError && e.status === 401 ? 'Parola yanlış.' : errorMessage(e)
      form.setError('password', { message: msg })
      form.setFocus('password')
    },
  })

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
              <FormLabel>Parola</FormLabel>
              <FormControl>
                <PasswordInput autoComplete='current-password' autoFocus placeholder='••••••••••' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button className='mt-2' disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className='animate-spin' /> : <LogIn />}
          Giriş yap
        </Button>
      </form>
    </Form>
  )
}
