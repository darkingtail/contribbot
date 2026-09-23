import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { prepareProviderRun, verifyProviderBinding } from 'contribbot-agent-runtime'
import type {
  ConsultRuntimeHooks,
  ConsultTurnRuntime,
  PreparedConsultInvocation,
} from './orchestration.js'
import type { Binding, TurnResult } from 'contribbot-core'
import { failedResult } from 'contribbot-core'

/** Map domain preparations and receipts; Provider mechanics belong to Runtime. */
export const nativeConsultRuntime: ConsultTurnRuntime = {
  verifyBinding: verifyProviderBinding,

  async prepare(runtimeBinding: Binding): Promise<PreparedConsultInvocation> {
    const invocation = await prepareProviderRun(runtimeBinding)
    const preparations = invocation.preparations.map(item => ({
      scratch_directory: item.directory, probe: item.capability, cleanup: item.cleanup,
    }))
    if (invocation.status === 'blocked') {
      return { status: 'blocked', preparations, result: failedResult(invocation.reason) }
    }
    return {
      status: 'ready',
      preparations,
      async run(prompt: string, hooks: ConsultRuntimeHooks): Promise<TurnResult> {
        return invocation.run(prompt, {
          dispatch: start => hooks.dispatch(start) as ChildProcessWithoutNullStreams,
          onProcess: hooks.onProcess,
          shouldTerminate: hooks.shouldTerminate,
        })
      },
    }
  },
}
