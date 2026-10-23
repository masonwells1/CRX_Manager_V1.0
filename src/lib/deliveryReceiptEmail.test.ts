import { describe, it, expect } from 'vitest';
import { buildDeliveryReceiptHtml, type DeliveryReceiptInput } from './deliveryReceiptEmail';

const base: DeliveryReceiptInput = {
  variant: 'completed',
  deliveryNumber: 'DEL-1001',
  contactName: 'Pat',
  dateText: '10/23/2026',
  lines: [{ name: '2,4-D Amine', qty: 5 }],
  signedBy: 'Pat Smith',
  isPartial: false,
};

describe('buildDeliveryReceiptHtml', () => {
  it('escapes typed product, contact and signer names', () => {
    const html = buildDeliveryReceiptHtml({
      ...base,
      contactName: 'Tom & <b>Jerry</b>',
      lines: [{ name: 'Weed <script>x</script> "Killer"', qty: 2 }],
      signedBy: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Jerry</b>');
    expect(html).toContain('Weed &lt;script&gt;x&lt;/script&gt; &quot;Killer&quot;');
    expect(html).toContain('Signed by: <strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    expect(html).toContain('Hi Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;,');
  });

  it('completion receipt carries its heading, date label and partial note', () => {
    const html = buildDeliveryReceiptHtml({ ...base, isPartial: true });
    expect(html).toContain('Delivery Completed');
    expect(html).toContain('Your delivery <strong>DEL-1001</strong> has been completed.');
    expect(html).toContain('>Date</td>');
    expect(html).toContain('This was a partial delivery.');
    expect(html).toContain('2,4-D Amine');
  });

  it('resend confirmation carries its own heading and omits a missing signer', () => {
    const html = buildDeliveryReceiptHtml({ ...base, variant: 'confirmation', signedBy: null });
    expect(html).toContain('Delivery Confirmation');
    expect(html).toContain('Here is your delivery confirmation for <strong>DEL-1001</strong>.');
    expect(html).toContain('>Completed</td>');
    expect(html).not.toContain('Signed by');
    expect(html).not.toContain('partial delivery');
  });
});
