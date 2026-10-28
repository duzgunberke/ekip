import { createFileRoute } from '@tanstack/react-router'
import { Panels } from '@/features/panels'

export const Route = createFileRoute('/_authenticated/paneller')({ component: Panels })
