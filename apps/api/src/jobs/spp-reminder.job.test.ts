import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// The cron fires at 06:00 WIB on the 1st. On a UTC server the instant is still
// 23:00 the day before, so the window is derived from the WIB month. Its
// boundaries are instants at 00:00 WIB (UTC+7), built with an explicit offset —
// not with `new Date(year, month, …)`, which reads the server's timezone.

vi.mock('@/lib/prisma', () => ({
  prisma: {
    invoice: { findMany: vi.fn() },
    notification: { create: vi.fn().mockResolvedValue({ id: 'n1' }) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('@/modules/notifications/notifications.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'n1' }),
}));
vi.mock('@/modules/notifications/email-sms.service', () => ({
  notificationService: { send: vi.fn().mockResolvedValue({ success: true }) },
}));

import { prisma } from '@/lib/prisma';
import * as notificationService from '@/modules/notifications/notifications.service';
import { notificationService as channelService } from '@/modules/notifications/email-sms.service';
import { sendMonthlySppReminders } from './spp-reminder.job';

const mockFindMany = prisma.invoice.findMany as unknown as ReturnType<typeof vi.fn>;
const mockCreateNotification = notificationService.createNotification as unknown as ReturnType<
  typeof vi.fn
>;
const mockSend = channelService.send as unknown as ReturnType<typeof vi.fn>;

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    amount: new Prisma.Decimal(500000),
    paidAmount: new Prisma.Decimal(0),
    period: 'Juli 2026',
    dueDate: new Date('2026-07-10'),
    paymentType: { name: 'SPP' },
    student: {
      id: 's1',
      user: { name: 'Ahmad' },
      parents: [
        { parent: { id: 'p1', name: 'Bapak Ahmad', phone: '+6281234567890' } },
        { parent: { id: 'p2', name: 'Ibu Ahmad', phone: null } },
      ],
    },
    ...overrides,
  };
}

describe('sendMonthlySppReminders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies every linked parent in-app and via WhatsApp when a phone exists', async () => {
    mockFindMany.mockResolvedValue([invoice()]);

    const result = await sendMonthlySppReminders(new Date('2026-07-01'));

    expect(result).toEqual({ invoices: 1, notified: 2 });
    // In-app for both parents
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification.mock.calls.map((c) => c[0].userId).sort()).toEqual(['p1', 'p2']);
    expect(mockCreateNotification.mock.calls[0][0].link).toBe('/parent/finance');
    // WhatsApp only for the parent with a phone number
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      channel: 'WHATSAPP',
      recipientPhone: '+6281234567890',
    });
    expect(mockSend.mock.calls[0][0].message).toContain('SPP');
    expect(mockSend.mock.calls[0][0].message).toContain('Ahmad');
  });

  it('targets a half-open WIB month [start, end) for unpaid invoices', async () => {
    mockFindMany.mockResolvedValue([]);
    await sendMonthlySppReminders(new Date('2026-07-15'));

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['PENDING', 'PARTIAL', 'OVERDUE']);
    // 00:00 WIB on 1 July = 2026-06-30T17:00:00Z; 00:00 WIB on 1 August =
    // 2026-07-31T17:00:00Z. `lt` (not `lte` on 23:59:59) keeps the month exact.
    expect(where.dueDate.gte).toEqual(new Date('2026-06-30T17:00:00.000Z'));
    expect(where.dueDate.lt).toEqual(new Date('2026-07-31T17:00:00.000Z'));
  });

  it('uses the WIB month at 2026-08-01 06:00 WIB, not the server’s July', async () => {
    // The reminder cron fires at 06:00 WIB on the 1st, two hours after
    // auto-billing. On a UTC server the instant is still 31 July — the window
    // must follow WIB, or it would look a month behind the invoices just issued.
    mockFindMany.mockResolvedValue([]);
    await sendMonthlySppReminders(new Date('2026-07-31T23:00:00Z'));

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.dueDate.gte).toEqual(new Date('2026-07-31T17:00:00.000Z'));
    expect(where.dueDate.lt).toEqual(new Date('2026-08-31T17:00:00.000Z'));
  });

  it('includes an invoice due the first instant of the WIB month and excludes one due the first instant of the next', async () => {
    // Boundary: the invoice that used to fall on the wrong side. 2026-07-31
    // 18:00Z is 1 August 01:00 WIB (inside the window); 2026-08-31 18:00Z is
    // 1 September 01:00 WIB (outside it).
    mockFindMany.mockResolvedValue([]);
    await sendMonthlySppReminders(new Date('2026-08-01T04:00:00Z'));

    const where = mockFindMany.mock.calls[0][0].where;
    const firstWibDay = new Date('2026-07-31T17:00:00.000Z'); // 1 Aug 00:00 WIB
    const nextWibMonth = new Date('2026-08-31T17:00:00.000Z'); // 1 Sep 00:00 WIB
    expect(where.dueDate.gte).toEqual(firstWibDay);
    expect(where.dueDate.lt).toEqual(nextWibMonth);

    const justInside = new Date('2026-07-31T18:00:00Z');
    const justOutside = new Date('2026-08-31T18:00:00Z');
    expect(justInside >= where.dueDate.gte && justInside < where.dueDate.lt).toBe(true);
    expect(justOutside >= where.dueDate.gte && justOutside < where.dueDate.lt).toBe(false);
  });

  it('keeps going when one parent notification fails', async () => {
    mockFindMany.mockResolvedValue([invoice()]);
    mockCreateNotification.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ id: 'n2' });

    const result = await sendMonthlySppReminders(new Date('2026-07-01'));
    expect(result.notified).toBe(1);
  });
});
