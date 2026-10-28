import { createFileRoute } from '@tanstack/react-router'
import { Runs } from '@/features/runs'

export const Route = createFileRoute('/_authenticated/calistirmalar')({ component: Runs })
