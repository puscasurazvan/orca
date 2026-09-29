import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRecordedWorkerLaunchSelection } from './worker-launch-preferences'
import {
  createOrchestrationWorkerReleaseHarness,
  isWorkerStartResult
} from './worker-release.test-support'

// A plain orchestration.dispatch attempt has no worker_dispatches row, so the retry precondition
// used to reject it and its abandoned Task had no documented route back.
describe('worker-start --retry-of a context-only Dispatch', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  async function dispatchContextOnly(
    spec: string
  ): Promise<{ taskId: string; dispatchId: string }> {
    const task = harness.db.createTask({ spec, runId: harness.activeRunId })
    const result = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_worker'
    })) as { dispatch: { id: string } }
    expect(harness.db.getWorkerDispatch(result.dispatch.id)).toBeUndefined()
    return { taskId: task.id, dispatchId: result.dispatch.id }
  }

  it('restarts the Task after the attempt is abandoned', async () => {
    const { taskId, dispatchId } = await dispatchContextOnly('unsupervised attempt')

    await expect(
      harness.call('orchestration.workerAbandon', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: false })
    expect(harness.db.getTask(taskId)?.status).toBe('blocked')

    const retried = (await harness.call('orchestration.workerStart', {
      task: taskId,
      from: 'term_coord',
      terminal: 'term_worker',
      retryOf: dispatchId
    })) as { dispatchId: string; state: string }

    expect(retried.state).toBe('ready')
    expect(harness.db.getDispatchContextById(retried.dispatchId)?.retry_of_dispatch_id).toBe(
      dispatchId
    )
    expect(harness.db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('still refuses to retry an attempt that has not settled', async () => {
    const { taskId, dispatchId } = await dispatchContextOnly('live attempt')

    await expect(
      harness.call('orchestration.workerStart', {
        task: taskId,
        from: 'term_coord',
        terminal: 'term_worker',
        retryOf: dispatchId
      })
    ).rejects.toMatchObject({ code: 'task_not_startable' })
  })
})

describe('worker-start --retry-of inherits the retried launch selection', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('creates a new terminal with the failed Dispatch agent when --agent and --terminal are both omitted', async () => {
    const { taskId, dispatchId } = await harness.startSettledWorker('failed', { agent: 'codex' })

    const retried = await harness.call('orchestration.workerStart', {
      task: taskId,
      from: 'term_coord',
      retryOf: dispatchId
    })
    if (!isWorkerStartResult(retried)) {
      throw new Error('Expected worker-start to return a ready dispatch')
    }

    const startOptions = harness.db.getWorkerDispatch(retried.dispatchId)?.start_options ?? '{}'
    expect(readRecordedWorkerLaunchSelection(startOptions)?.agent).toBe('codex')
  })

  it('lets an explicit --agent on retry win over the recorded selection', async () => {
    const { taskId, dispatchId } = await harness.startSettledWorker('failed', { agent: 'codex' })

    const retried = await harness.call('orchestration.workerStart', {
      task: taskId,
      from: 'term_coord',
      retryOf: dispatchId,
      agent: 'claude'
    })
    if (!isWorkerStartResult(retried)) {
      throw new Error('Expected worker-start to return a ready dispatch')
    }

    const startOptions = harness.db.getWorkerDispatch(retried.dispatchId)?.start_options ?? '{}'
    expect(readRecordedWorkerLaunchSelection(startOptions)?.agent).toBe('claude')
  })

  it('still raises the missing-agent error when --retry-of names an unknown Dispatch', async () => {
    const task = harness.db.createTask({ spec: 'orphan retry', runId: harness.activeRunId })

    await expect(
      harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        retryOf: 'ctx_does_not_exist'
      })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })
  })
})
