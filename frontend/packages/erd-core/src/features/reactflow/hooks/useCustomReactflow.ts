import { type FitViewOptions, useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { MAX_ZOOM, MIN_ZOOM } from '../constants'

export const useCustomReactflow = () => {
  const reactFlowInstance = useReactFlow()
  const { fitView: primitiveFitView, ...restFunctions } = reactFlowInstance

  const fitView = useCallback(
    async (options?: FitViewOptions) => {
      // NOTE: Added setTimeout() to reference the updated nodes after setNodes() updates the value.
      return new Promise<void>((resolve) => {
        // First timeout ensures nodes are updated
        setTimeout(() => {
          primitiveFitView({
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            ...options,
          })
          // Second timeout ensures node state updates are completed
          setTimeout(resolve, 50)
        }, 50)
      })
    },
    [primitiveFitView],
  )

  return {
    ...restFunctions,
    fitView,
  }
}
