import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Upload, Search, CheckCircle, Clock, AlertCircle, XCircle } from 'lucide-react';
import { supabase } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useOCRProcessor } from '../hooks/useOCRProcessor';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import { BulkTicketUpload } from '../components/blendtickets/BulkTicketUpload';
import DataTable from '../components/ui/DataTable';
import { usePageMeta } from '../hooks/usePageMeta';
import type { BlendTicket, Customer } from '../types';

export function BlendTickets() {
  usePageMeta();
  useAuth();
  const [tickets, setTickets] = useState<BlendTicket[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [reviewFilter, setReviewFilter] = useState<string>('all');

  const { isProcessing, processedCount } = useOCRProcessor(true);

  useEffect(() => {
    loadData();
  }, [processedCount]);

  async function loadData() {
    try {
      const [ticketsResult, customersResult] = await Promise.all([
        supabase
          .from('blend_tickets')
          .select(`
            *,
            uploader:profiles!blend_tickets_uploaded_by_fkey(id, full_name, email),
            reviewer:profiles!blend_tickets_reviewed_by_fkey(id, full_name, email),
            customer:customers(id, farm_name),
            images:blend_ticket_images(count)
          `)
          .order('created_at', { ascending: false }),
        supabase
          .from('customers')
          .select('*')
          .eq('is_active', true)
          .order('farm_name')
      ]);

      if (ticketsResult.error) throw ticketsResult.error;
      if (customersResult.error) throw customersResult.error;

      setTickets(ticketsResult.data || []);
      setCustomers(customersResult.data || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  }

  const filteredTickets = tickets.filter(ticket => {
    const matchesSearch =
      ticket.ticket_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.customer?.farm_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.driver_name?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesReview = reviewFilter === 'all' || ticket.review_status === reviewFilter;

    return matchesSearch && matchesStatus && matchesReview;
  });

  function getStatusBadge(status: string) {
    const variants: Record<string, { variant: 'default' | 'warning' | 'success' | 'error'; icon: any }> = {
      pending: { variant: 'default', icon: Clock },
      processing: { variant: 'warning', icon: Clock },
      completed: { variant: 'success', icon: CheckCircle },
      failed: { variant: 'error', icon: XCircle },
      needs_review: { variant: 'warning', icon: AlertCircle },
    };

    const config = variants[status] || variants.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant}>
        <Icon className="h-3 w-3" />
        {status.replace('_', ' ')}
      </Badge>
    );
  }

  function getReviewBadge(reviewStatus: string) {
    const variants: Record<string, 'default' | 'success' | 'error'> = {
      unreviewed: 'default',
      approved: 'success',
      rejected: 'error',
    };

    return (
      <Badge variant={variants[reviewStatus] || 'default'}>
        {reviewStatus}
      </Badge>
    );
  }

  const columns = [
    {
      key: 'ticket_number',
      header: 'Ticket #',
      render: (ticket: BlendTicket) => (
        <Link
          to={`/blend-tickets/${ticket.id}`}
          className="text-blue-600 hover:text-blue-700 font-medium"
        >
          {ticket.ticket_number}
        </Link>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (ticket: BlendTicket) => (
        <span>{ticket.customer?.farm_name || '-'}</span>
      ),
    },
    {
      key: 'ticket_date',
      header: 'Date',
      render: (ticket: BlendTicket) => (
        <span>
          {ticket.ticket_date
            ? new Date(ticket.ticket_date).toLocaleDateString()
            : '-'}
        </span>
      ),
    },
    {
      key: 'driver_name',
      header: 'Driver',
      render: (ticket: BlendTicket) => (
        <span>{ticket.driver_name || '-'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (ticket: BlendTicket) => getStatusBadge(ticket.status),
    },
    {
      key: 'review_status',
      header: 'Review',
      render: (ticket: BlendTicket) => getReviewBadge(ticket.review_status),
    },
    {
      key: 'ocr_confidence_score',
      header: 'Confidence',
      render: (ticket: BlendTicket) => (
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-gray-200 rounded-full h-2 max-w-[80px]">
            <div
              className={`h-2 rounded-full ${
                ticket.ocr_confidence_score >= 70
                  ? 'bg-green-500'
                  : ticket.ocr_confidence_score >= 50
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
              style={{ width: `${ticket.ocr_confidence_score}%` }}
            />
          </div>
          <span className="text-sm text-gray-600 min-w-[40px]">
            {ticket.ocr_confidence_score}%
          </span>
        </div>
      ),
    },
    {
      key: 'uploaded_by',
      header: 'Uploaded By',
      render: (ticket: BlendTicket) => (
        <span className="text-sm">{ticket.uploader?.full_name || '-'}</span>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-8 w-8 text-gray-700" />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Blend Tickets</h1>
            <p className="text-gray-600 mt-1">
              Upload and manage blend ticket images with automatic OCR processing
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isProcessing && (
            <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
              <Clock className="h-4 w-4 animate-spin" />
              Processing tickets...
            </div>
          )}
          <Button onClick={() => setShowUpload(!showUpload)}>
            <Upload className="h-4 w-4" />
            {showUpload ? 'Hide Upload' : 'Upload Tickets'}
          </Button>
        </div>
      </div>

      {showUpload && (
        <BulkTicketUpload
          customers={customers}
          onUploadComplete={() => {
            setShowUpload(false);
            loadData();
          }}
        />
      )}

      <Card className="p-6">
        <div className="mb-6 space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search tickets..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="w-48">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="needs_review">Needs Review</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            <div className="w-48">
              <select
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Reviews</option>
                <option value="unreviewed">Unreviewed</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
        </div>

        {filteredTickets.length === 0 ? (
          <EmptyState
            icon={<FileText className="w-6 h-6 text-gray-400" />}
            title="No blend tickets found"
            description={
              tickets.length === 0
                ? "Upload your first blend ticket to get started"
                : "No tickets match your current filters"
            }
            action={
              tickets.length === 0 ? (
                <Button onClick={() => setShowUpload(true)}>
                  <Upload className="h-4 w-4" />
                  Upload Tickets
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            columns={columns as any}
            data={filteredTickets as any}
          />
        )}
      </Card>
    </div>
  );
}
