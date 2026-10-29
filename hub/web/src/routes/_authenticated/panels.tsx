import { createFileRoute } from '@tanstack/react-router'
import { Panels } from '@/features/panels'

export const Route = createFileRoute('/_authenticated/panels')({ component: Panels })
