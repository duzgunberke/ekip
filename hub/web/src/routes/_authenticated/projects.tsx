import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Projects } from '@/features/projects'

export const Route = createFileRoute('/_authenticated/projects')({
  validateSearch: z.object({ p: z.string().optional(), q: z.string().optional() }),
  component: Projects,
})
