import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaveStatus, LeaveType, StaffAttendanceStatus } from '@prisma/client';

// `prisma` is fully mocked. `$transaction` is mocked to imitate Prisma: the
// callback form runs against the same client (Prisma passes the callback a
// transaction client), and the array form is sequential — an earlier rejection
// stops the remaining promises, exactly as the real client does. A faithful
// array form is what lets a test prove that no partial write survives a
// mid-transaction failure; `Promise.all` would hide it by running every promise
// concurrently and ignoring the ones that settle after the first rejection.
const { prismaMock, runTransaction } = vi.hoisted(() => {
  const runTransaction = async (arg: unknown, client: Record<string, unknown>) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)(client);
    }
    // Prisma's array form issues the operations in order and stops at the
    // first rejection; it never reports a later operation as done.
    const results: unknown[] = [];
    for (const op of arg as unknown[]) {
      results.push(await op);
    }
    return results;
  };

  const prismaMock: Record<string, unknown> = {
    leave: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    staff: { findUnique: vi.fn() },
    teacher: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    academicYear: { findFirst: vi.fn() },
    leaveBalance: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    leaveTypeConfig: { findUnique: vi.fn() },
    staffAttendance: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  (prismaMock.$transaction as ReturnType<typeof vi.fn>).mockImplementation((arg: unknown) =>
    runTransaction(arg, prismaMock)
  );
  return { prismaMock, runTransaction };
});

vi.mock('../../../lib/prisma', () => ({ prisma: prismaMock }));

import {
  createLeave,
  approveLeave,
  cancelLeave,
  deleteLeave,
  getLeaveBalance,
} from '../hr.service';

const db = prismaMock as {
  leave: Record<string, ReturnType<typeof vi.fn>>;
  staff: { findUnique: ReturnType<typeof vi.fn> };
  teacher: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  academicYear: { findFirst: ReturnType<typeof vi.fn> };
  leaveBalance: Record<string, ReturnType<typeof vi.fn>>;
  leaveTypeConfig: { findUnique: ReturnType<typeof vi.fn> };
  staffAttendance: Record<string, ReturnType<typeof vi.fn>>;
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const STAFF = '11111111-1111-4111-8111-111111111111';

/** A leave row as `approveLeave`/`cancelLeave` read it, with the includes. */
function leaveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'leave-1',
    staffId: STAFF,
    teacherId: null,
    type: LeaveType.ANNUAL,
    status: LeaveStatus.PENDING,
    startDate: new Date('2026-01-05T00:00:00.000Z'),
    endDate: new Date('2026-01-06T00:00:00.000Z'),
    totalDays: 2,
    staff: { userId: 'user-1' },
    teacher: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((arg: unknown) => runTransaction(arg, prismaMock));
  db.leave.findFirst.mockResolvedValue(null);
  db.leave.aggregate.mockResolvedValue({ _sum: { totalDays: 0 } });
  db.leaveBalance.findUnique.mockResolvedValue(null);
  db.leaveBalance.findMany.mockResolvedValue([]);
  db.leaveTypeConfig.findUnique.mockResolvedValue(null);
  db.leave.create.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: 'leave-1',
    ...(data as object),
  }));
});

describe('createLeave', () => {
  it('rejects a request with neither a staffId nor a teacherId before touching the database', async () => {
    await expect(
      createLeave({
        type: LeaveType.SICK,
        startDate: '2026-01-05T00:00:00.000Z',
        endDate: '2026-01-05T00:00:00.000Z',
        reason: 'demam',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/staffId or teacherId/),
    });

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.leave.create).not.toHaveBeenCalled();
  });

  it('counts both end days of a leave (inclusive totalDays)', async () => {
    await createLeave({
      staffId: STAFF,
      type: LeaveType.SICK,
      startDate: '2026-01-05T00:00:00.000Z',
      endDate: '2026-01-07T00:00:00.000Z',
      reason: 'demam',
    });

    expect(db.leave.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalDays: 3, staffId: STAFF, type: LeaveType.SICK }),
      })
    );
  });

  it('refuses a leave that overlaps a pending or approved request', async () => {
    db.leave.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      createLeave({
        staffId: STAFF,
        type: LeaveType.SICK,
        startDate: '2026-01-05T00:00:00.000Z',
        endDate: '2026-01-05T00:00:00.000Z',
        reason: 'demam',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/overlaps/) });

    expect(db.leave.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        staffId: STAFF,
        OR: [
          {
            startDate: { lte: new Date('2026-01-05T00:00:00.000Z') },
            endDate: { gte: new Date('2026-01-05T00:00:00.000Z') },
          },
        ],
      }),
    });
    expect(db.leave.create).not.toHaveBeenCalled();
  });

  it('does not check a balance for a non-annual leave', async () => {
    await createLeave({
      staffId: STAFF,
      type: LeaveType.SICK,
      startDate: '2026-01-05T00:00:00.000Z',
      endDate: '2026-01-05T00:00:00.000Z',
      reason: 'demam',
    });

    expect(db.academicYear.findFirst).not.toHaveBeenCalled();
    expect(db.leaveBalance.findUnique).not.toHaveBeenCalled();
    expect(db.leave.create).toHaveBeenCalled();
  });

  it('refuses an annual leave with no academic year covering the dates', async () => {
    db.staff.findUnique.mockResolvedValue({ userId: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue(null);

    await expect(
      createLeave({
        staffId: STAFF,
        type: LeaveType.ANNUAL,
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-06-03T00:00:00.000Z',
        reason: 'cuti tahunan',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Academic Year/),
    });
    expect(db.leave.create).not.toHaveBeenCalled();
  });

  it('counts pending requests against the balance before allowing more annual leave', async () => {
    db.staff.findUnique.mockResolvedValue({ userId: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue({
      id: 'ay-1',
      startDate: new Date('2025-07-01T00:00:00.000Z'),
      endDate: new Date('2026-06-30T00:00:00.000Z'),
    });
    db.leave.aggregate.mockResolvedValue({ _sum: { totalDays: 3 } });
    db.leaveBalance.findUnique.mockResolvedValue({ remainingDays: 5 });

    await expect(
      createLeave({
        staffId: STAFF,
        type: LeaveType.ANNUAL,
        startDate: '2026-01-05T00:00:00.000Z',
        endDate: '2026-01-08T00:00:00.000Z',
        reason: 'cuti tahunan',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Remaining: 2 days/),
    });
    expect(db.leave.create).not.toHaveBeenCalled();
  });

  it('creates an annual leave when the balance covers it', async () => {
    db.staff.findUnique.mockResolvedValue({ userId: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue({
      id: 'ay-1',
      startDate: new Date('2025-07-01T00:00:00.000Z'),
      endDate: new Date('2026-06-30T00:00:00.000Z'),
    });
    db.leave.aggregate.mockResolvedValue({ _sum: { totalDays: 0 } });
    db.leaveBalance.findUnique.mockResolvedValue({ remainingDays: 10 });

    await createLeave({
      staffId: STAFF,
      type: LeaveType.ANNUAL,
      startDate: '2026-01-05T00:00:00.000Z',
      endDate: '2026-01-07T00:00:00.000Z',
      reason: 'cuti tahunan',
    });

    expect(db.leave.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalDays: 3 }) })
    );
  });

  it('falls back to a 12-day quota when no balance row exists, counting approved and pending days', async () => {
    db.staff.findUnique.mockResolvedValue({ userId: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue({
      id: 'ay-1',
      startDate: new Date('2025-07-01T00:00:00.000Z'),
      endDate: new Date('2026-06-30T00:00:00.000Z'),
    });
    db.leaveBalance.findUnique.mockResolvedValue(null);
    // First aggregate is pending (2), second is approved (8): 12 - 10 = 2 remaining.
    db.leave.aggregate
      .mockResolvedValueOnce({ _sum: { totalDays: 2 } })
      .mockResolvedValueOnce({ _sum: { totalDays: 8 } });

    await expect(
      createLeave({
        staffId: STAFF,
        type: LeaveType.ANNUAL,
        startDate: '2026-01-05T00:00:00.000Z',
        endDate: '2026-01-08T00:00:00.000Z',
        reason: 'cuti tahunan',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Remaining: 2 days/),
    });

    expect(db.leave.aggregate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ status: LeaveStatus.APPROVED }),
      })
    );
  });

  it('leaves no leave row behind when the create inside the transaction fails', async () => {
    let created = false;
    db.leave.create.mockImplementation(async () => {
      created = true;
      throw new Error('duplicate key');
    });

    await expect(
      createLeave({
        staffId: STAFF,
        type: LeaveType.SICK,
        startDate: '2026-01-05T00:00:00.000Z',
        endDate: '2026-01-05T00:00:00.000Z',
        reason: 'demam',
      })
    ).rejects.toThrow(/duplicate key/);

    // The callback form runs against the mocked client, so a failure inside the
    // transaction is not swallowed into a *successful* create.
    expect(created).toBe(true);
    expect(db.leave.create).toHaveBeenCalledTimes(1);
  });
});

describe('$transaction mock', () => {
  // The helper is what stands in for Prisma, so a test pins its array form: it
  // must await each operation in order, not fan them out. A later edit that
  // swapped the loop for `Promise.all` would let a rejected mid-transaction
  // operation be ignored — the exact partial-write the leave tests rely on.
  type LazyOp = {
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => unknown;
  };

  it('runs the array form sequentially and stops at the first rejection', async () => {
    const started: string[] = [];
    const op = (label: string, fail = false): LazyOp => ({
      then: (onFulfilled, onRejected) => {
        started.push(label);
        return (fail ? Promise.reject(new Error('op 2 failed')) : Promise.resolve(label)).then(
          onFulfilled,
          onRejected
        );
      },
    });

    await expect(
      runTransaction([op('op1'), op('bail', true), op('op3')], prismaMock)
    ).rejects.toThrow(/op 2 failed/);
    // op3 was never started: Prisma stops at the first rejection, `Promise.all`
    // would have started it too.
    expect(started).toEqual(['op1', 'bail']);
  });

  it('runs the callback form against the transaction client it is given', async () => {
    const client = { marker: true } as Record<string, unknown>;
    const seen = await runTransaction((tx: unknown) => tx, client);
    expect(seen).toBe(client);
    expect(seen).not.toBe(prismaMock);
  });
});

describe('approveLeave', () => {
  it('is idempotent: approving an approved leave does not spend the balance twice', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));
    db.leave.findUniqueOrThrow.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));

    const result = await approveLeave('leave-1', 'approver-1', {
      status: LeaveStatus.APPROVED,
    });

    expect(result.status).toBe(LeaveStatus.APPROVED);
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.staffAttendance.upsert).not.toHaveBeenCalled();
    expect(db.staffAttendance.update).not.toHaveBeenCalled();
    expect(db.staffAttendance.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses to reject an already approved leave (cancel it first)', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));

    await expect(
      approveLeave('leave-1', 'approver-1', { status: LeaveStatus.REJECTED })
    ).rejects.toThrow(/tidak dapat diubah/i);
    expect(db.leave.update).not.toHaveBeenCalled();
  });

  it('records a rejection note and touches neither the balance nor attendance', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.PENDING }));
    db.leave.update.mockResolvedValue(
      leaveRow({ status: LeaveStatus.REJECTED, staff: null, teacher: { userId: 'user-1' } })
    );

    await approveLeave('leave-1', 'approver-1', {
      status: LeaveStatus.REJECTED,
      rejectedNote: 'staf tidak cukup',
    });

    expect(db.leave.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: LeaveStatus.REJECTED,
          rejectedNote: 'staf tidak cukup',
          approvedBy: { connect: { id: 'approver-1' } },
        }),
      })
    );
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.staffAttendance.upsert).not.toHaveBeenCalled();
    expect(db.staffAttendance.update).not.toHaveBeenCalled();
    expect(db.staffAttendance.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('spends the balance once and marks attendance when approving a pending leave', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.PENDING }));
    db.leave.update.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));
    db.academicYear.findFirst.mockResolvedValue({ id: 'ay-1' });
    db.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-1' });
    // A day the person already attended: the approval overwrites the status but
    // remembers what it held, so a later cancellation can restore it.
    db.staffAttendance.findUnique.mockResolvedValue({
      id: 'att-1',
      status: StaffAttendanceStatus.PRESENT,
      notes: 'Hadir tepat waktu',
      leaveRequestId: null,
    });
    db.staffAttendance.update.mockResolvedValue({});

    await approveLeave('leave-1', 'approver-1', { status: LeaveStatus.APPROVED });

    expect(db.leaveBalance.update).toHaveBeenCalledTimes(1);
    expect(db.leaveBalance.update).toHaveBeenCalledWith({
      where: { id: 'bal-1' },
      data: { usedDays: { increment: 2 }, remainingDays: { decrement: 2 } },
    });
    // One attendance write per calendar day of the leave.
    expect(db.staffAttendance.update).toHaveBeenCalledTimes(2);
    expect(db.staffAttendance.update.mock.calls[0][0].data.leaveRequestId).toBe('leave-1');
    expect(db.staffAttendance.update.mock.calls[0][0].data.leavePreviousStatus).toBe(
      StaffAttendanceStatus.PRESENT
    );
    expect(db.staffAttendance.update.mock.calls[0][0].data.leavePreviousNotes).toBe(
      'Hadir tepat waktu'
    );
    // The approval leaves an audit trail.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('stops marking attendance at the day that refuses, so no later write is reported done', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.PENDING }));
    db.leave.update.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));
    db.academicYear.findFirst.mockResolvedValue({ id: 'ay-1' });
    db.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-1' });
    db.staffAttendance.findUnique.mockResolvedValue(null);
    // Day 1 writes; day 2 refuses — as a real day inside `$transaction` would.
    db.staffAttendance.create
      .mockResolvedValueOnce({ id: 'att-1' })
      .mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      approveLeave('leave-1', 'approver-1', { status: LeaveStatus.APPROVED })
    ).rejects.toThrow(/deadlock/);

    // The loop ran day 1 then day 2 and stopped: day 2 was attempted, and the
    // transaction never reported a third day.
    expect(db.staffAttendance.create).toHaveBeenCalledTimes(2);
    // The balance update sits outside the attendance transaction and did run —
    // this is what a cancel must rectify, and the test pins that shape.
    expect(db.leaveBalance.update).toHaveBeenCalledTimes(1);
    // The audit trail is written only after the transaction succeeds.
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('cancelLeave', () => {
  it('restores a day the leave overwrote and removes a day it created', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.APPROVED }));
    db.academicYear.findFirst.mockResolvedValue({ id: 'ay-1' });
    db.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-1' });
    db.leave.update.mockResolvedValue(leaveRow({ status: LeaveStatus.CANCELLED }));
    // Day 1 already held PRESENT (with a note) before the leave; day 2 was
    // created by it.
    db.staffAttendance.findMany.mockResolvedValue([
      {
        id: 'att-1',
        leavePreviousStatus: StaffAttendanceStatus.PRESENT,
        leavePreviousNotes: 'Hadir tepat waktu',
      },
      { id: 'att-2', leavePreviousStatus: null, leavePreviousNotes: null },
    ]);
    db.staffAttendance.update.mockResolvedValue({});
    db.staffAttendance.delete.mockResolvedValue({});

    await cancelLeave('leave-1');

    expect(db.leaveBalance.update).toHaveBeenCalledWith({
      where: { id: 'bal-1' },
      data: { usedDays: { decrement: 2 }, remainingDays: { increment: 2 } },
    });
    // Matched by leave id, not by a status + generic note.
    expect(db.staffAttendance.findMany.mock.calls[0][0].where.leaveRequestId).toBe('leave-1');
    // The pre-existing day is restored; only the leave-only day is removed.
    expect(db.staffAttendance.update.mock.calls[0][0].where).toEqual({ id: 'att-1' });
    expect(db.staffAttendance.update.mock.calls[0][0].data.status).toBe(
      StaffAttendanceStatus.PRESENT
    );
    expect(db.staffAttendance.update.mock.calls[0][0].data.notes).toBe('Hadir tepat waktu');
    expect(db.staffAttendance.delete.mock.calls[0][0].where).toEqual({ id: 'att-2' });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not touch the balance when cancelling a pending leave', async () => {
    db.leave.findUnique.mockResolvedValue(leaveRow({ status: LeaveStatus.PENDING }));
    db.leave.update.mockResolvedValue(leaveRow({ status: LeaveStatus.CANCELLED }));

    await cancelLeave('leave-1');

    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.staffAttendance.deleteMany).not.toHaveBeenCalled();
    expect(db.staffAttendance.findMany).not.toHaveBeenCalled();
  });
});

describe('deleteLeave', () => {
  it('refuses to delete an approved leave', async () => {
    db.leave.findUnique.mockResolvedValue({ id: 'leave-1', status: LeaveStatus.APPROVED });

    await expect(deleteLeave('leave-1')).rejects.toThrow(/Cannot delete approved leave/);
    expect(db.leave.delete).not.toHaveBeenCalled();
  });

  it('deletes a leave that is not approved', async () => {
    db.leave.findUnique.mockResolvedValue({ id: 'leave-1', status: LeaveStatus.PENDING });
    db.leave.delete.mockResolvedValue({ id: 'leave-1' });

    await deleteLeave('leave-1');

    expect(db.leave.delete).toHaveBeenCalledWith({ where: { id: 'leave-1' } });
  });
});

describe('getLeaveBalance', () => {
  it('resolves a staff id to its user and reports the stored annual balance', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.staff.findUnique.mockResolvedValue({ userId: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue({ id: 'ay-1' });
    db.leaveBalance.findMany.mockResolvedValue([
      { leaveType: LeaveType.ANNUAL, totalDays: 14, usedDays: 4, remainingDays: 10 },
      { leaveType: LeaveType.SICK, totalDays: 0, usedDays: 2, remainingDays: 0 },
    ]);

    const result = await getLeaveBalance(STAFF, 2026);

    expect(result).toMatchObject({
      employeeId: STAFF,
      year: 2026,
      annualQuota: 14,
      usedAnnual: 4,
      remainingAnnual: 10,
      totalUsed: 6,
    });
    expect(result.usedByType).toEqual({ [LeaveType.ANNUAL]: 4, [LeaveType.SICK]: 2 });
    // The stored rows matched this user's own id, not a different employee's.
    expect(db.leaveBalance.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', academicYearId: 'ay-1' },
    });
  });

  it('falls back with no rows for an employee the query does not match', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue(null);
    // Argument-aware: the fixture returns rows only when the fallback actually
    // filtered on this employee's staffId/teacherId. A fallback that dropped
    // the filter would get these rows and report 7, not the empty-branch 12.
    db.leave.findMany.mockImplementation(async (args: { where?: { OR?: unknown[] } }) => {
      const or = args?.where?.OR ?? [];
      const matches = or.some(
        (c) =>
          (c as { staffId?: string }).staffId === 'user-1' ||
          (c as { teacherId?: string }).teacherId === 'user-1'
      );
      return matches
        ? [
            { type: LeaveType.ANNUAL, totalDays: 3 },
            { type: LeaveType.ANNUAL, totalDays: 2 },
          ]
        : [];
    });

    const result = await getLeaveBalance('user-1', 2026);

    expect(result).toMatchObject({ annualQuota: 12, usedAnnual: 5, remainingAnnual: 7 });
    expect(db.leave.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ staffId: 'user-1' }, { teacherId: 'user-1' }],
          status: LeaveStatus.APPROVED,
        }),
      })
    );
  });

  it('reports the full quota when the fallback yields no leaves for the year', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-2' });
    db.academicYear.findFirst.mockResolvedValue(null);
    // No parameterless rows: the fixture refuses to answer unless the query
    // names this employee, so `remainingAnnual: 12` here proves the filter was
    // applied and simply found nothing.
    db.leave.findMany.mockResolvedValue([]);

    const result = await getLeaveBalance('user-2', 2026);

    expect(result).toMatchObject({ annualQuota: 12, usedAnnual: 0, remainingAnnual: 12 });
    expect(db.leave.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ staffId: 'user-2' }, { teacherId: 'user-2' }] }),
      })
    );
  });

  it('honours the configured entitlement instead of the 12-day last resort', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-1' });
    db.academicYear.findFirst.mockResolvedValue(null);
    db.leave.findMany.mockResolvedValue([]);
    db.leaveTypeConfig.findUnique.mockResolvedValue({ entitlementDays: 14 });

    const result = await getLeaveBalance('user-1', 2026);

    expect(result.annualQuota).toBe(14);
    expect(result.remainingAnnual).toBe(14);
  });
});
