import { createFileRoute } from '@tanstack/react-router'
import { Runs } from '@/features/runs'

export const Route = createFileRoute('/_authenticated/runs')({ component: Runs })
