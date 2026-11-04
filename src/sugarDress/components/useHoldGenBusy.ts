import { useCallback, useRef } from 'react'

/** Hold one canvas busy slot for the lifetime of a generation request.
 * The slot is taken when the request starts and released when it settles,
 * including after this panel unmounts. Mount, callback identity, and unmount
 * do not report `false`, so an idle tab cannot end another job. */
export function useHoldGenBusy(onGenBusy: (busy: boolean) => void) {
  const onGenBusyRef = useRef(onGenBusy)
  onGenBusyRef.current = onGenBusy

  return useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    onGenBusyRef.current(true)
    try {
      return await task()
    } finally {
      onGenBusyRef.current(false)
    }
  }, [])
}
