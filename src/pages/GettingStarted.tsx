import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Send,
  ShoppingCart,
  Truck,
  Receipt,
  ChevronRight,
  LayoutDashboard,
  PlayCircle,
  Camera,
  CheckCircle2,
  BookOpen,
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
        <p className="text-gray-500 ml-10">Your quick guide to CRX Manager</p>
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

      {/* Section Cards */}
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
            description="Start it, adjust quantities if needed, take photos, get the customer to sign, then hit Complete. The office gets notified automatically."
            buttonLabel="Go to Deliveries"
            path="/deliveries"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <SectionCard
            title="Quotes"
            description="Start here. Build a quote, mark as Planned to reserve inventory, or send directly to the customer."
            buttonLabel="Go to Quotes"
            path="/quotes"
          />
          <SectionCard
            title="Orders & Deliveries"
            description="Once a quote is accepted, convert it to an order. Then schedule deliveries — drivers pick them up from their dashboard."
            buttonLabel="Go to Orders"
            path="/orders"
          />
          <SectionCard
            title="Team Board"
            description="Keep your team in sync. Create notes, tasks, and announcements to keep your team coordinated."
            buttonLabel="Go to Team Board"
            path="/team-board"
          />
        </div>
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
