import { useParams } from 'react-router-dom';
import FieldApplicationInvoice from '../pages/FieldApplicationInvoice';

// Discard every field and confirmation when the invoice identity changes,
// including an existing invoice -> new invoice. Keep the page's async load
// ownership checks: a discarded request must not navigate or install state.
export default function FieldApplicationInvoiceRoute() {
  const { id } = useParams();
  return <FieldApplicationInvoice key={id ?? 'new-field-app-invoice'} />;
}
