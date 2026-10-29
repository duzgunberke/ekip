import { Fragment } from 'react'
import { type Row, type Table as TTable, flexRender } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTablePagination } from './pagination'
import { useT } from '@/lib/i18n'

type DataTableProps<TData> = {
  table: TTable<TData>
  loading?: boolean
  empty?: React.ReactNode
  onRowClick?: (row: Row<TData>) => void
  renderExpanded?: (row: Row<TData>) => React.ReactNode
  className?: string
}

/** Table body shared by the İşler / Çalıştırmalar pages (shadcn-admin's table, generalised). */
export function DataTable<TData>({
  table,
  loading,
  empty = 'Kayıt yok.',
  onRowClick,
  renderExpanded,
  className,
}: DataTableProps<TData>) {
  const t = useT()
  const cols = table.getVisibleLeafColumns()
  const rows = table.getRowModel().rows
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className='overflow-x-auto rounded-md border'>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className='hover:bg-transparent'>
                {hg.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn(
                      header.column.columnDef.meta?.className,
                      header.column.columnDef.meta?.thClassName
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={i} className='hover:bg-transparent'>
                  {cols.map((c) => (
                    <TableCell key={c.id} className={c.columnDef.meta?.className}>
                      <Skeleton className='h-4 w-full max-w-40' />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    data-state={row.getIsExpanded() ? 'selected' : undefined}
                    className={cn(onRowClick && 'cursor-pointer')}
                    onClick={(e) => {
                      // Let links/buttons inside the row do their own thing.
                      if ((e.target as HTMLElement).closest('a,button,[role="button"]')) return
                      onRowClick?.(row)
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          cell.column.columnDef.meta?.className,
                          cell.column.columnDef.meta?.tdClassName
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                  {renderExpanded && row.getIsExpanded() && (
                    <TableRow className='bg-muted/20 hover:bg-muted/20'>
                      <TableCell colSpan={cols.length} className='p-0 whitespace-normal'>
                        {renderExpanded(row)}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            ) : (
              <TableRow className='hover:bg-transparent'>
                <TableCell colSpan={cols.length} className='h-32 text-center text-muted-foreground'>
                  {typeof empty === 'string' ? t(empty) : empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {!loading && table.getPageCount() > 1 && <DataTablePagination table={table} />}
    </div>
  )
}
