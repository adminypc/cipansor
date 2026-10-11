/**
 * Monthly SPP reminder job.
 *
 * Runs on the 1st of each month (after auto-billing has generated the
 * month's invoices): every parent linked to a student with an unpaid
 * invoice due this month gets an in-app notification plus a WhatsApp
 * message. WhatsApp goes through the multi-provider whatsapp.service
 * (Meta WhatsApp Cloud API by default; log-only in SIMULATOR mode when
 * no provider credentials are configured).
 */

import { PaymentStatus, NotificationType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import * as notificationService from '@/modules/notifications/notifications.service';
import { notificationService as channelService } from '@/modules/notifications/email-sms.service';
import { wibMonthYear } from '@/utils/wib-day';

const formatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
});

/**
 * Send SPP reminders for every unpaid invoice due in the given month to all
 * linked parents. Returns a summary for logging and tests.
 */
export async function sendMonthlySppReminders(now: Date = new Date()) {
  // Match the WIB month the auto-billing job labelled its invoices with, so the
  // reminder window does not drift a month away from them.
  const { year, month } = wibMonthYear(now);
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59);

  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL, PaymentStatus.OVERDUE] },
      dueDate: { gte: monthStart, lte: monthEnd },
    },
    include: {
      paymentType: { select: { name: true } },
      student: {
        select: {
          id: true,
          user: { select: { name: true } },
          parents: {
            select: {
              parent: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      },
    },
  });

  let notified = 0;
  for (const invoice of invoices) {
    const amountDue = invoice.amount.sub(invoice.paidAmount);
    for (const link of invoice.student.parents) {
      const parent = link.parent;
      const message =
        `Tagihan ${invoice.paymentType.name} ${invoice.period ?? ''} a.n. ` +
        `${invoice.student.user.name} sebesar ${formatter.format(amountDue.toNumber())} ` +
        `jatuh tempo ${invoice.dueDate.toLocaleDateString('id-ID')}. ` +
        `Mohon unggah bukti pembayaran melalui menu Tagihan & Pembayaran.`;

      try {
        await notificationService.createNotification({
          userId: parent.id,
          title: `Tagihan ${invoice.paymentType.name} Bulan Ini`,
          message,
          type: NotificationType.PAYMENT,
          link: '/parent/finance',
          priority: 'HIGH',
          channels: ['IN_APP'],
          recipientType: 'INDIVIDUAL',
        });
        if (parent.phone) {
          await channelService.send({
            channel: 'WHATSAPP',
            userId: parent.id,
            recipientPhone: parent.phone,
            type: 'PAYMENT_REMINDER',
            title: `Tagihan ${invoice.paymentType.name}`,
            message,
          });
        }
        notified++;
      } catch (error) {
        logger.error(`[SppReminder] Failed to notify parent ${parent.id}:`, error);
      }
    }
  }

  logger.info(
    `[SppReminder] ${invoices.length} unpaid invoices this month, ${notified} parent notifications sent`
  );
  return { invoices: invoices.length, notified };
}
