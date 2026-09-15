import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO error_group_jobs")) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM friction_tickets')) {
        return {
          rowCount: 1,
          rows: [{ ticket_id: 'ticket-1', project_id: 'project-1' }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    connect: vi.fn(async () => tx),
  };
  return {
    tx,
    pool,
    lockTicketPublication: vi.fn(),
    getTicket: vi.fn(async () => ({
      id: 'ticket-1',
      project_id: 'project-1',
      environment_id: 'env-1',
      status: 'published',
      live_generation: 1,
      evidence_version: 7,
      kind: 'defect',
    })),
    liveIncident: vi.fn(async () => ({
      id: 'group-1',
      fix_substate: 'none',
      evidence_version_used: 7,
      investigation_status: 'done',
      explained_signal_ids: ['explained-old'],
      pr_url: null,
    })),
    verifiedEvidence: vi.fn(async () => ({
      users: 0,
      sessions: 2,
      accounts: [],
      sessionIds: ['session-1', 'session-2'],
      signalIds: ['fresh-1', 'fresh-2'],
      representative: null,
    })),
    investigationAllowed: vi.fn(() => true),
    enqueueTicketInvestigation: vi.fn(async () => true),
  };
});

vi.mock('../../db.js', () => ({
  getPool: () => mocks.pool,
  LeaseLostError: class LeaseLostError extends Error {},
}));

vi.mock('../tickets-db.js', () => ({
  publicationPaused: () => false,
  lockTicketPublication: mocks.lockTicketPublication,
  getTicket: mocks.getTicket,
  liveIncident: mocks.liveIncident,
  verifiedEvidence: mocks.verifiedEvidence,
  investigationAllowed: mocks.investigationAllowed,
  enqueueTicketInvestigation: mocks.enqueueTicketInvestigation,
}));

vi.mock('../confirm-job.js', () => ({
  applyConfirmationTransition: vi.fn(),
  prepareConfirmationTransition: vi.fn(),
  confirmationSnapshotCurrent: vi.fn(),
}));

vi.mock('../../metered.js', () => ({
  PhaseMeter: class PhaseMeter {
    async flush(): Promise<void> {}
  },
}));

vi.mock('../../run-logs/context.js', () => ({ runContextFromJob: vi.fn() }));

import { scheduleFrictionReconciliation } from '../reconcile-job.js';

describe('rolling cause coverage reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.query.mockResolvedValue({ rowCount: 0, rows: [] });
    mocks.pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO error_group_jobs")) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM friction_tickets')) {
        return {
          rowCount: 1,
          rows: [{ ticket_id: 'ticket-1', project_id: 'project-1' }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    mocks.pool.connect.mockResolvedValue(mocks.tx);
    mocks.getTicket.mockResolvedValue({
      id: 'ticket-1',
      project_id: 'project-1',
      environment_id: 'env-1',
      status: 'published',
      live_generation: 1,
      evidence_version: 7,
      kind: 'defect',
    });
    mocks.liveIncident.mockResolvedValue({
      id: 'group-1',
      fix_substate: 'none',
      evidence_version_used: 7,
      investigation_status: 'done',
      explained_signal_ids: ['explained-old'],
      pr_url: null,
    });
    mocks.verifiedEvidence.mockResolvedValue({
      users: 0,
      sessions: 2,
      accounts: [],
      sessionIds: ['session-1', 'session-2'],
      signalIds: ['fresh-1', 'fresh-2'],
      representative: null,
    });
    mocks.investigationAllowed.mockReturnValue(true);
    mocks.enqueueTicketInvestigation.mockResolvedValue(true);
  });

  it('queues when time-window dilution drops cause coverage below half without a new evidence version', async () => {
    await scheduleFrictionReconciliation();

    expect(mocks.enqueueTicketInvestigation).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTicketInvestigation).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        id: 'ticket-1',
        live_generation: 1,
        evidence_version: 7,
      }),
      'group-1',
    );
  });

  it('does not queue when the seven-day window is empty', async () => {
    mocks.verifiedEvidence.mockResolvedValue({
      users: 0,
      sessions: 0,
      accounts: [],
      sessionIds: [],
      signalIds: [],
      representative: null,
    });

    await scheduleFrictionReconciliation();

    expect(mocks.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('does not queue when current evidence still has at least half cause coverage', async () => {
    mocks.liveIncident.mockResolvedValue({
      id: 'group-1',
      fix_substate: 'none',
      evidence_version_used: 7,
      investigation_status: 'done',
      explained_signal_ids: ['fresh-1'],
      pr_url: null,
    });

    await scheduleFrictionReconciliation();

    expect(mocks.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });

  it('does not queue if a fix starts after the scheduler candidate scan', async () => {
    mocks.liveIncident.mockResolvedValue({
      id: 'group-1',
      fix_substate: 'fixing',
      evidence_version_used: 7,
      investigation_status: 'done',
      explained_signal_ids: ['explained-old'],
      pr_url: 'https://github.com/acme/repo/pull/1',
    });

    await scheduleFrictionReconciliation();

    expect(mocks.enqueueTicketInvestigation).not.toHaveBeenCalled();
  });
});
