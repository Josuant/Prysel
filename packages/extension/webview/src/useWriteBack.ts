import { useMemo, useState } from 'react'
import type { ControlModel } from '@prysel/morphology'
import type { Program } from '@prysel/python'
import { createWriteBack, type WriteBack } from './writeBack.ts'

/** La cola de escritura de vuelta (ver `writeBack.ts`), como un hook: `pending` es lo aún sin confirmar. */
export function useWriteBack(
  post: (message: unknown) => void,
  onCreated?: (program: Program, line: number) => void,
): WriteBack & { pending: Record<string, ControlModel> } {
  const [pending, setPending] = useState<Record<string, ControlModel>>({})
  const queue = useMemo(
    () => createWriteBack({ post, onPending: setPending, ...(onCreated ? { onCreated } : {}) }),
    [post, onCreated],
  )
  return { pending, change: queue.change, submit: queue.submit, received: queue.received }
}
