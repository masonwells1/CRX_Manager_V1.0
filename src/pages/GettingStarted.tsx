import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Send,
  ShoppingCart,
  Truck,
  Receipt,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  LayoutDashboard,
  PlayCircle,
  Camera,
  CheckCircle2,
  BookOpen,
  Package,
  PackageCheck,
  DollarSign,
  ClipboardList,
  Users,
  BarChart3,
  AlertTriangle,
  Lightbulb,
  Target,
  Sprout,
  ArrowDown,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const STORAGE_KEY = 'crx_hide_getting_started';

interface Step {
  label: string;
  icon: React.ReactNode;
}

function StepperRow({ steps }: { steps: Step[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 py-6">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center gap-3">
          <div className="flex flex-col items-center gap-2">
            <div className="w-14 h-14 rounded-full bg-crx-green text-white flex items-center justify-center shadow-md">
              {step.icon}
            </div>
            <span className="text-sm font-medium text-gray-700 text-center max-w-[100px]">
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <ChevronRight className="w-5 h-5 text-gray-300 flex-shrink-0 mt-[-1.5rem]" />
          )}
        </div>
      ))}
    </div>
  );
}

interface SectionCardProps {
  title: string;
  description: string;
  buttonLabel: string;
  path: string;
}

function SectionCard({ title, description, buttonLabel, path }: SectionCardProps) {
  const navigate = useNavigate();
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-600 mb-4">{description}</p>
      <button
        onClick={() => navigate(path)}
        className="inline-flex items-center gap-2 px-4 py-2 bg-crx-green text-white text-sm font-medium rounded-lg hover:bg-crx-green/90 transition-colors"
      >
        {buttonLabel}
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ── Expandable guide section ── */
interface GuideSectionProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function GuideSection({ icon, title, subtitle, children, defaultOpen = false }: GuideSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-crx-green/10 flex items-center justify-center text-crx-green flex-shrink-0">
            {icon}
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-500">{subtitle}</p>
          </div>
        </div>
        {open ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 text-sm text-gray-700 leading-relaxed space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Numbered step within a guide ── */
function GuideStep({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-crx-green text-white text-xs font-bold flex items-center justify-center mt-0.5">
        {num}
      </div>
      <div>
        <p className="font-medium text-gray-900 mb-1">{title}</p>
        <div className="text-gray-600">{children}</div>
      </div>
    </div>
  );
}

/* ── Tip callout ── */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
      <Lightbulb className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
      <span className="text-amber-800">{children}</span>
    </div>
  );
}

const adminSteps: Step[] = [
  { label: 'Create Quote', icon: <FileText className="w-6 h-6" /> },
  { label: 'Send to Customer', icon: <Send className="w-6 h-6" /> },
  { label: 'Convert to Order', icon: <ShoppingCart className="w-6 h-6" /> },
  { label: 'Schedule Delivery', icon: <Truck className="w-6 h-6" /> },
  { label: 'Invoice & Collect', icon: <Receipt className="w-6 h-6" /> },
];

const driverSteps: Step[] = [
  { label: 'Check Dashboard', icon: <LayoutDashboard className="w-6 h-6" /> },
  { label: 'Start Delivery', icon: <PlayCircle className="w-6 h-6" /> },
  { label: 'Get Signature & Photos', icon: <Camera className="w-6 h-6" /> },
  { label: 'Complete', icon: <CheckCircle2 className="w-6 h-6" /> },
];

export default function GettingStarted() {
  const { profile } = useAuth();
  const isDriver = profile?.role === 'driver';

  const [hideOnLogin, setHideOnLogin] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      if (hideOnLogin) {
        localStorage.setItem(STORAGE_KEY, 'true');
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [hideOnLogin]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <BookOpen className="w-7 h-7 text-crx-green" />
          <h1 className="text-2xl font-bold text-gray-900">Getting Started</h1>
        </div>
        <p className="text-gray-500 ml-10">
          {isDriver
            ? 'Everything you need to know about completing deliveries.'
            : 'A complete guide to CRX Manager — from quoting to collecting payment.'}
        </p>
      </div>

      {/* Workflow Stepper */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-2 text-center">
          {isDriver ? 'Your Delivery Workflow' : 'The Core Workflow'}
        </h2>
        <p className="text-gray-500 text-sm text-center mb-2">
          {isDriver
            ? 'Every delivery follows these four steps.'
            : 'Every sale follows these five steps, from quote to payment.'}
        </p>
        <StepperRow steps={isDriver ? driverSteps : adminSteps} />
      </div>

      {/* Quick Links */}
      {isDriver ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SectionCard
            title="Your Dashboard"
            description="Your scheduled deliveries show up here each morning. Check in to see what's on your route."
            buttonLabel="Go to Dashboard"
            path="/"
          />
          <SectionCard
            title="Completing a Delivery"
            description="Start it, adjust quantities if needed, take photos, get the customer to sign, then hit Complete."
            buttonLabel="Go to Deliveries"
            path="/deliveries"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SectionCard
            title="Quotes"
            description="Build quotes, mark as planned to reserve inventory, or send to customers."
            buttonLabel="Go to Quotes"
            path="/quotes"
          />
          <SectionCard
            title="Orders"
            description="Accepted quotes become orders. Schedule deliveries from here."
            buttonLabel="Go to Orders"
            path="/orders"
          />
          <SectionCard
            title="Inventory"
            description="Track on-hand quantities, prebooked amounts, and reorder alerts."
            buttonLabel="Go to Inventory"
            path="/inventory"
          />
          <SectionCard
            title="Team Board"
            description="Tasks, notes, and announcements to keep your team coordinated."
            buttonLabel="Go to Team Board"
            path="/team-board"
          />
        </div>
      )}

      {/* ─── Detailed Guide Sections ─── */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <Target className="w-5 h-5 text-crx-green" />
          <h2 className="text-lg font-semibold text-gray-900">
            {isDriver ? 'Delivery Guide' : 'Detailed Workflow Guides'}
          </h2>
        </div>
        <p className="text-gray-500 text-sm mb-4">
          Click any section below to expand it and see step-by-step instructions.
        </p>
      </div>

      {/* ─── QUOTE BUILDING ─── */}
      {!isDriver && (
        <GuideSection
          icon={<FileText className="w-5 h-5" />}
          title="Building Quotes"
          subtitle="Creating, pricing, and sending quotes to customers"
          defaultOpen
        >
          <GuideStep num={1} title="Create a new quote">
            <p>Go to <strong>Quotes → New Quote</strong>. Select the customer — their tier pricing (1, 2, or 3) auto-fills product prices. Set an expiration date if needed.</p>
          </GuideStep>
          <GuideStep num={2} title="Add sections and products">
            <p>Quotes are organized into <strong>sections</strong> (e.g. &quot;Pre-Emerge&quot;, &quot;Post-Emerge&quot;). Each section can have a &quot;Needed By&quot; date and header notes that appear on the PDF. Add products to each section — quantities, rates, and prices are per-item.</p>
          </GuideStep>
          <GuideStep num={3} title="Use crop programs (optional)">
            <p>Click <strong>&quot;Apply Program&quot;</strong> to auto-fill a section from a saved crop program template. This saves time for common product mixes like &quot;2026 Corn Program&quot;. Build templates under <strong>Crop Programs</strong> in the sidebar.</p>
          </GuideStep>
          <GuideStep num={4} title="Save as Planned Program (optional)">
            <p>Toggle <strong>&quot;Planned Program&quot;</strong> to reserve inventory via holds. This tells the system the customer is likely to buy — their products are set aside. Planned quotes show a special badge in the customer&apos;s quote list.</p>
          </GuideStep>
          <GuideStep num={5} title="Send to customer">
            <p>Click <strong>&quot;Send Quote&quot;</strong>. This generates a PDF, emails it to the customer (if they have an email on file), and changes the status to &quot;Sent&quot;. You can revise and resend as many times as needed.</p>
          </GuideStep>
          <GuideStep num={6} title="Convert to order">
            <p>When the customer accepts, click <strong>&quot;Convert to Order&quot;</strong>. This creates an order with all the quoted items, releases any inventory holds, and books the prebooked quantities. The quote status changes to &quot;Accepted&quot;.</p>
          </GuideStep>
          <Tip>Use the <strong>version history</strong> panel (top-right of the quote builder) to snapshot your quote before making changes. You can always restore a previous version.</Tip>
          <Tip>The <strong>&quot;New from Last Quote&quot;</strong> button on the customer detail page lets you quickly create a new quote pre-filled with the customer&apos;s most recent quote items — great for repeat orders.</Tip>
        </GuideSection>
      )}

      {/* ─── PLANNED PROGRAMS ─── */}
      {!isDriver && (
        <GuideSection
          icon={<Sprout className="w-5 h-5" />}
          title="Planned Programs & Inventory Holds"
          subtitle="Reserving inventory for customers before they formally order"
        >
          <p>A <strong>Planned Program</strong> is a quote that&apos;s been flagged as &quot;likely to convert.&quot; When you mark a quote as planned:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Inventory holds</strong> are automatically created for each product in the quote</li>
            <li>The held quantities are subtracted from &quot;Net Free&quot; inventory so other quotes don&apos;t over-promise</li>
            <li>Holds show in the inventory page as a separate column</li>
            <li>Each section can have a <strong>&quot;Needed By&quot;</strong> date — holds that expire trigger alerts</li>
          </ul>
          <GuideStep num={1} title="Mark a quote as Planned">
            <p>In the quote builder, toggle the <strong>&quot;Planned Program&quot;</strong> switch at the top. Save the quote.</p>
          </GuideStep>
          <GuideStep num={2} title="Monitor holds in inventory">
            <p>On the <strong>Inventory</strong> page, the &quot;Planned Holds&quot; column shows how much is reserved by planned quotes. &quot;Net Free&quot; = Available − Prebooked − Planned Holds.</p>
          </GuideStep>
          <GuideStep num={3} title="Converting releases holds">
            <p>When a planned quote is converted to an order, holds are automatically released and the inventory is booked instead. No manual cleanup needed.</p>
          </GuideStep>
          <Tip>If a customer declines or a quote expires, holds are automatically released and inventory becomes available again.</Tip>
        </GuideSection>
      )}

      {/* ─── ORDERS ─── */}
      {!isDriver && (
        <GuideSection
          icon={<ShoppingCart className="w-5 h-5" />}
          title="Managing Orders"
          subtitle="From confirmed order to scheduled deliveries"
        >
          <GuideStep num={1} title="Orders are created from quotes">
            <p>Most orders come from converting an accepted quote. You can also create a <strong>direct order</strong> (Orders → New Order) for walk-in or phone orders — this skips the quote step.</p>
          </GuideStep>
          <GuideStep num={2} title="Review order details">
            <p>On the order detail page you&apos;ll see all line items, pricing, the linked customer, and commission splits. Orders start in <strong>&quot;Confirmed&quot;</strong> status.</p>
          </GuideStep>
          <GuideStep num={3} title="Schedule deliveries">
            <p>Click <strong>&quot;New Delivery&quot;</strong> on the order. Select which items and quantities to deliver. You can do partial deliveries — the order moves to &quot;Partially Fulfilled&quot; until everything is delivered.</p>
          </GuideStep>
          <GuideStep num={4} title="Track remaining items">
            <p>The order detail shows a progress bar for each item. If a delivery can&apos;t include everything, &quot;remainders&quot; are automatically created and show in <strong>Delivery Remainders</strong> for follow-up.</p>
          </GuideStep>
          <Tip>Use <strong>Quick Delivery</strong> (on the order page) to create a delivery + draft invoice in one step — great for same-day pickups.</Tip>
        </GuideSection>
      )}

      {/* ─── DELIVERIES ─── */}
      <GuideSection
        icon={<Truck className="w-5 h-5" />}
        title={isDriver ? 'Completing Deliveries' : 'Deliveries — The Two-Step Flow'}
        subtitle={isDriver ? 'How to confirm, deliver, and complete' : 'Confirm → Complete is mandatory for every delivery'}
      >
        <p className="font-medium text-gray-900">Every delivery follows a strict two-step process:</p>
        <GuideStep num={1} title="Confirm the delivery (start it)">
          <p>Click <strong>&quot;Start Delivery&quot;</strong>. This moves the delivery from &quot;Scheduled&quot; to &quot;In Progress.&quot; The driver is now on the road. You can still adjust quantities at this point if the truck can&apos;t hold everything.</p>
        </GuideStep>
        <GuideStep num={2} title="Complete the delivery">
          <p>At the customer site:</p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li><strong>Take photos</strong> of the product at the delivery site (optional but recommended)</li>
            <li><strong>Get the customer&apos;s signature</strong> — type their name in the signature field</li>
            <li>Click <strong>&quot;Complete Delivery&quot;</strong></li>
          </ul>
          <p className="mt-2">On completion, the system automatically: reduces inventory, creates transaction records, generates a draft invoice, and emails the customer a delivery confirmation.</p>
        </GuideStep>
        <Tip>If you can&apos;t deliver the full quantity, adjust it down before completing. The remaining amount automatically becomes a &quot;delivery remainder&quot; for follow-up.</Tip>
        {!isDriver && (
          <Tip>Check the <strong>Delivery Calendar</strong> (on the Deliveries page) for a visual overview of all scheduled deliveries by date.</Tip>
        )}
      </GuideSection>

      {/* ─── SUPPLIER POs ─── */}
      {!isDriver && (
        <GuideSection
          icon={<PackageCheck className="w-5 h-5" />}
          title="Supplier Purchase Orders"
          subtitle="Ordering from vendors and tracking what's received"
        >
          <GuideStep num={1} title="Create a PO">
            <p>Go to <strong>Supplier POs → New PO</strong>. Select the vendor, add products with quantities and unit costs. Save as Draft, then <strong>&quot;Submit&quot;</strong> when ready to send.</p>
          </GuideStep>
          <GuideStep num={2} title="Receive items">
            <p>When a shipment arrives, open the PO and click <strong>&quot;Receive Items&quot;</strong>. Enter actual quantities received, select condition (good / damaged / short), and add lot numbers if applicable. Damaged items trigger automatic notifications.</p>
          </GuideStep>
          <GuideStep num={3} title="Track outstanding items">
            <p>Use the <strong>&quot;Outstanding Items&quot;</strong> tab on the Supplier POs page to see everything still on order across all vendors — no need to open each PO individually. Filter by vendor, export to CSV or PDF.</p>
          </GuideStep>
          <GuideStep num={4} title="Quick Receive (alternative)">
            <p>For fast-paced receiving, use <strong>Quick Receive</strong> (under Receiving in the sidebar). Scan or search products, enter quantities, and the system auto-matches to the oldest open PO.</p>
          </GuideStep>
          <Tip>The <strong>Receiving Log</strong> keeps a full audit trail of everything received. You can reverse a receiving record if there was an error.</Tip>
          <Tip>Use <strong>&quot;Import from PDF&quot;</strong> on the PO list page to auto-extract items from supplier invoices via OCR.</Tip>
        </GuideSection>
      )}

      {/* ─── INVENTORY ─── */}
      {!isDriver && (
        <GuideSection
          icon={<Package className="w-5 h-5" />}
          title="Inventory Management"
          subtitle="On-hand tracking, forecasting, and cycle counts"
        >
          <p>The inventory page has two tabs:</p>
          <div className="pl-4 space-y-2">
            <p><strong>Inventory tab:</strong> Shows every product with Available, Prebooked, On Order, Planned Holds, and Net Free quantities. Click the ledger icon to see the full transaction history for any product.</p>
            <p><strong>Forecast tab:</strong> Shows projected inventory based on open orders, upcoming deliveries, and incoming POs — helps you spot shortages before they happen.</p>
          </div>
          <div className="mt-3 p-3 bg-gray-50 rounded-lg">
            <p className="font-medium text-gray-900 mb-1">Key inventory concepts:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Available</strong> — physically on hand in the warehouse</li>
              <li><strong>Prebooked</strong> — reserved by confirmed orders awaiting delivery</li>
              <li><strong>On Order</strong> — ordered from suppliers but not yet received</li>
              <li><strong>Planned Holds</strong> — reserved by planned program quotes</li>
              <li><strong>Net Free</strong> = Available − Prebooked − Planned Holds (what you can actually promise to a new customer)</li>
            </ul>
          </div>
          <Tip>Run <strong>Cycle Counts</strong> regularly to verify physical inventory against system records. Variances are automatically adjusted and logged.</Tip>
          <Tip>The <strong>Transaction Ledger</strong> (click the ledger icon on any inventory row) shows every add/subtract event with running balance — essential for tracking down discrepancies.</Tip>
        </GuideSection>
      )}

      {/* ─── INVOICING & PAYMENTS ─── */}
      {!isDriver && (
        <GuideSection
          icon={<DollarSign className="w-5 h-5" />}
          title="Invoicing & Payments"
          subtitle="Billing customers and tracking what's owed"
        >
          <GuideStep num={1} title="Draft invoices are created automatically">
            <p>When a delivery is completed, a draft invoice is created automatically with the delivered items and prices from the order. You can also create invoices manually.</p>
          </GuideStep>
          <GuideStep num={2} title="Post the invoice">
            <p>Review the draft, then click <strong>&quot;Post&quot;</strong>. This locks the invoice, updates the AR balance, and makes it available for payment. Posted invoices can&apos;t be edited — void and re-create if there&apos;s an error.</p>
          </GuideStep>
          <GuideStep num={3} title="Record payments">
            <p>On the <strong>Payments</strong> page, record payments against orders. The system allocates payments to invoices automatically. Prepay credits can be applied at time of payment.</p>
          </GuideStep>
          <GuideStep num={4} title="Monitor AR aging">
            <p>The <strong>AR Aging</strong> page shows outstanding balances grouped by 30/60/90+ days. Use &quot;Send AR Reminders&quot; to auto-email customers with outstanding balances, or &quot;Email Statements&quot; to send detailed PDF statements.</p>
          </GuideStep>
          <Tip>All financial changes are logged to the <strong>financial audit log</strong> — this is append-only and can never be modified. Check it anytime under Settings → Audit Log.</Tip>
        </GuideSection>
      )}

      {/* ─── REPORTS ─── */}
      {!isDriver && (
        <GuideSection
          icon={<BarChart3 className="w-5 h-5" />}
          title="Reports & Analytics"
          subtitle="Financial dashboard, sales reports, and compliance"
        >
          <div className="space-y-2">
            <p><strong>Financial Dashboard:</strong> Overview of revenue, margins, AR, and inventory value. Includes bottom-10 margin alerts and monthly trend charts.</p>
            <p><strong>Sales Reports:</strong> Drill into sales by product, customer, month, or rep. Use the &quot;Customer View&quot; toggle to hide cost/margin data for customer-facing exports.</p>
            <p><strong>AR Aging:</strong> Track outstanding balances, send reminders, and email statements.</p>
            <p><strong>Commissions:</strong> View pending and paid commissions by sales rep. Commission splits are defined per customer and applied automatically to orders.</p>
            <p><strong>RUP Sales Register:</strong> Compliance reporting for Restricted Use Products — auto-populated from invoices.</p>
          </div>
          <Tip>Most report pages support <strong>CSV and PDF export</strong> — look for the download buttons in the top-right.</Tip>
        </GuideSection>
      )}

      {/* ─── COMMON PITFALLS ─── */}
      <GuideSection
        icon={<AlertTriangle className="w-5 h-5" />}
        title="Common Mistakes to Avoid"
        subtitle="Things that trip up new users"
      >
        <ul className="space-y-3">
          {!isDriver && (
            <>
              <li className="flex gap-2">
                <span className="text-red-500 font-bold flex-shrink-0">✕</span>
                <span><strong>Forgetting to post invoices.</strong> Draft invoices don&apos;t affect AR balances. If a customer says they don&apos;t owe anything, check if the invoice is still in &quot;Draft&quot; status.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-500 font-bold flex-shrink-0">✕</span>
                <span><strong>Over-promising inventory.</strong> Always check &quot;Net Free&quot; (not just &quot;Available&quot;) before quoting. Available includes prebooked quantities that are already spoken for.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-500 font-bold flex-shrink-0">✕</span>
                <span><strong>Not using Planned Programs.</strong> If a customer is likely to buy, mark the quote as planned. Otherwise, another quote could promise the same inventory.</span>
              </li>
            </>
          )}
          <li className="flex gap-2">
            <span className="text-red-500 font-bold flex-shrink-0">✕</span>
            <span><strong>Skipping the signature on delivery.</strong> Completing without a name in the &quot;Signed By&quot; field means no proof of delivery. Always get it.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-red-500 font-bold flex-shrink-0">✕</span>
            <span><strong>Not taking delivery photos.</strong> Photos are your proof that the right products were dropped at the right location. Take at least one per stop.</span>
          </li>
          {!isDriver && (
            <li className="flex gap-2">
              <span className="text-red-500 font-bold flex-shrink-0">✕</span>
              <span><strong>Editing product prices in the middle of a season.</strong> Existing quotes and orders keep their original prices — only new quotes pick up the change. This is by design.</span>
            </li>
          )}
        </ul>
      </GuideSection>

      {/* ─── KEYBOARD SHORTCUTS / TIPS ─── */}
      {!isDriver && (
        <GuideSection
          icon={<ClipboardList className="w-5 h-5" />}
          title="Pro Tips"
          subtitle="Power-user features that save time"
        >
          <ul className="space-y-2">
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>Bulk operations:</strong> Most list pages support multi-select. Check the boxes on the left, then use the bulk action bar (Export CSV, Download PDF, Delete, etc.).</span>
            </li>
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>Quick search:</strong> Every data table has a search bar. Type a PO number, customer name, or product to filter instantly.</span>
            </li>
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>Inline editing:</strong> On the Products and Inventory pages, click any editable cell to change values directly in the table — no need to open a detail page.</span>
            </li>
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>PDF imports:</strong> On the Supplier POs page, use &quot;Import from PDF&quot; to upload supplier invoices. OCR extracts product names, quantities, and costs automatically.</span>
            </li>
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>Quote versioning:</strong> Before making major changes to a quote, use the version history panel to take a snapshot. You can compare versions side-by-side and restore any previous version.</span>
            </li>
            <li className="flex gap-2">
              <ArrowDown className="w-4 h-4 text-crx-green flex-shrink-0 mt-1" />
              <span><strong>Seasonal rollover:</strong> At season end, use the &quot;Roll Over&quot; button in the Quote Builder to copy a quote into the next season with updated dates.</span>
            </li>
          </ul>
        </GuideSection>
      )}

      {/* ─── ROLES ─── */}
      {!isDriver && (
        <GuideSection
          icon={<Users className="w-5 h-5" />}
          title="Roles & Permissions"
          subtitle="Who can do what in the system"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Action</th>
                  <th className="text-center py-2 px-3 font-medium text-gray-700">Admin</th>
                  <th className="text-center py-2 px-3 font-medium text-gray-700">Sales Rep</th>
                  <th className="text-center py-2 px-3 font-medium text-gray-700">Driver</th>
                  <th className="text-center py-2 px-3 font-medium text-gray-700">Applicator</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Create/edit quotes', true, true, false, false],
                  ['Create/edit orders', true, true, false, false],
                  ['Start/complete deliveries', true, true, true, false],
                  ['Create POs', true, false, false, false],
                  ['Receive inventory', true, true, false, false],
                  ['Post invoices', true, false, false, false],
                  ['Record payments', true, false, false, false],
                  ['Month-end close', true, false, false, false],
                  ['Manage commissions', true, false, false, false],
                  ['View reports', true, true, false, false],
                  ['Manage users/settings', true, false, false, false],
                ].map(([action, admin, sales, driver, applicator]) => (
                  <tr key={action as string} className="border-t border-gray-100">
                    <td className="py-2 px-3 text-gray-700">{action as string}</td>
                    <td className="py-2 px-3 text-center">{admin ? <CheckCircle2 className="w-4 h-4 text-crx-green inline" /> : <span className="text-gray-300">—</span>}</td>
                    <td className="py-2 px-3 text-center">{sales ? <CheckCircle2 className="w-4 h-4 text-crx-green inline" /> : <span className="text-gray-300">—</span>}</td>
                    <td className="py-2 px-3 text-center">{driver ? <CheckCircle2 className="w-4 h-4 text-crx-green inline" /> : <span className="text-gray-300">—</span>}</td>
                    <td className="py-2 px-3 text-center">{applicator ? <CheckCircle2 className="w-4 h-4 text-crx-green inline" /> : <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GuideSection>
      )}

      {/* Auto-dismiss checkbox */}
      <div className="flex items-center gap-3 pt-2">
        <input
          type="checkbox"
          id="hide-getting-started"
          checked={hideOnLogin}
          onChange={(e) => setHideOnLogin(e.target.checked)}
          className="w-4 h-4 text-crx-green border-gray-300 rounded focus:ring-crx-green"
        />
        <label htmlFor="hide-getting-started" className="text-sm text-gray-500">
          Don&apos;t show this on login
        </label>
      </div>
    </div>
  );
}
