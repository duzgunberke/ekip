import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { CodeMap } from '@/features/codemap'

export const Route = createFileRoute('/_authenticated/code-map')({
  validateSearch: z.object({ proje: z.string().optional() }),
  component: CodeMap,
})
