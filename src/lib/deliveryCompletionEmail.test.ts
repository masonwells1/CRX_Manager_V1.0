/**
 * The customer delivery receipt carries no delivery photos (Mason, 2026-10-14): staff photos are
 * private, and a photo link in an email would work for anyone holding it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('./emailService', () => ({
  sendEmail: H.sendEmail,
  buildEmailHtml: (body: string) => `<html>${body}</html>`,
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { sendDeliveryCompletionEmail } from './deliveryCompletionEmail';

beforeEach(() => {
  H.sendEmail.mockReset();
  H.sendEmail.mockResolvedValue({ success: true });
});

describe('sendDeliveryCompletionEmail', () => {
  it('sends the receipt with items and signer but no photo, image or storage link', async () => {
    await sendDeliveryCompletionEmail({
      customerEmail: 'farm@example.invalid',
      contactName: 'Pat',
      deliveryNumber: 'DEL-2026-0001',
      deliveryId: 'd1',
      customerId: 'c1',
      items: [{ name: 'Glyphosate 2.5 GL', qty: 4 }],
      isPartial: false,
      signedBy: 'Pat Farmer',
    });
    expect(H.sendEmail).toHaveBeenCalledTimes(1);
    const { html, email_type: type } = H.sendEmail.mock.calls[0][0];
    expect(type).toBe('delivery_completed');
    expect(html).toContain('Glyphosate 2.5 GL');
    expect(html).toContain('Pat Farmer');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/storage\/v1|supabase\.co/);
    expect(html).not.toMatch(/Delivery Photos/);
  });

  it('escapes the driver-typed signer and product names (readability report B1)', async () => {
    await sendDeliveryCompletionEmail({
      customerEmail: 'farm@example.invalid',
      contactName: 'Tom & <Jerry>',
      deliveryNumber: 'DEL-2026-0002',
      deliveryId: 'd2',
      customerId: 'c1',
      items: [{ name: '2,4-D Amine <4L>', qty: 1 }],
      isPartial: false,
      signedBy: "Pat <O'Brien> & Sons",
    });
    const { html } = H.sendEmail.mock.calls[0][0];
    expect(html).toContain('2,4-D Amine &lt;4L&gt;');
    expect(html).toContain("Signed by: <strong>Pat &lt;O'Brien&gt; &amp; Sons</strong>");
    expect(html).toContain('Hi Tom &amp; &lt;Jerry&gt;,');
    expect(html).not.toContain('<4L>');
  });
});
