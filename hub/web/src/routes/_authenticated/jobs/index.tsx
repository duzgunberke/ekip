import { createFileRoute } from '@tanstack/react-router'
import { Jobs } from '@/features/jobs'

export const Route = createFileRoute('/_authenticated/jobs/')({ component: Jobs })
