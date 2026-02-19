import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Check, X, Plus, Trash2, Image as ImageIcon, AlertCircle, Link2, Unlink, ShoppingCart, ClipboardCheck } from 'lucide-react';
import { supabase, checkMutationResult, assertRpcResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Skeleton from '../components/ui/Skeleton';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { validateBlendMath } from '../lib/blendMathValidator';
import type { BlendTicket, BlendTicketProduct, BlendTicketImage, BlendTicketToOrderItem, Customer, Product, Order, OrderItem, Field } from '../types';

export function BlendTicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  usePageMeta();
  const { toast } = useToast();

  const [ticket, setTicket] = useState<BlendTicket | null>(null);
  const [images, setImages] = useState<BlendTicketImage[]>([]);
  const [products, setProducts] = useState<BlendTicketProduct[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  // Phase 3: Order linkage state
  const [fields, setFields] = useState<Field[]>([]);
  const [linkedOrders, setLinkedOrders] = useState<BlendTicketToOrderItem[]>([]);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [availableOrders, setAvailableOrders] = useState<(Order & { items?: OrderItem[] })[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [linking, setLinking] = useState(false);
  const [newOrderNumber, setNewOrderNumber] = useState('');
  const [newOrderDate, setNewOrderDate] = useState(new Date().toISOString().split('T')[0]);
  const [newOrderNotes, setNewOrderNotes] = useState('');

  const [formData, setFormData] = useState({
    customer_id: '',
    ticket_date: '',
    ticket_time: '',
    job_number: '',
    invoice_number: '',
    driver_name: '',
    applicator_name: '',
    mixer_name: '',
    tank_number: '',
    vehicle_info: '',
    field_names: '',
    total_acres: '',
    application_rate: '',
    total_volume: '',
    total_volume_unit: '',
    notes: '',
  });

  useEffect(() => {
    if (id) {
      loadTicketData();
    }
  }, [id]);

  useEffect(() => {
    const ticketData = {
      total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
      total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
      total_volume_unit: formData.total_volume_unit || null,
    };
    const productData = products.map(p => ({
      product_name: p.product_name,
      quantity: p.quantity,
      unit: p.unit,
      rate_per_acre: p.rate_per_acre,
      rate_per_acre_unit: p.rate_per_acre_unit,
    }));
    setWarnings(validateBlendMath(ticketData, productData));
  }, [products, formData.total_acres, formData.total_volume, formData.total_volume_unit]);

  async function loadTicketData() {
    try {
      const [ticketResult, imagesResult, productsResult, allProductsResult, customersResult, fieldsResult, linkedResult] = await Promise.all([
        supabase
          .from('blend_tickets')
          .select(`
            *,
            uploader:profiles!blend_tickets_uploaded_by_fkey(id, full_name),
            reviewer:profiles!blend_tickets_reviewed_by_fkey(id, full_name),
            customer:customers(id, farm_name),
            field:fields(id, field_name),
            salesman:profiles!blend_tickets_salesman_id_fkey(id, full_name)
          `)
          .eq('id', id)
          .single(),
        supabase
          .from('blend_ticket_images')
          .select('*')
          .eq('blend_ticket_id', id)
          .order('upload_order'),
        supabase
          .from('blend_ticket_products')
          .select('*, product:products(*)')
          .eq('blend_ticket_id', id)
          .order('sequence_order'),
        supabase
          .from('products')
          .select('*')
          .eq('is_active', true)
          .order('product_name'),
        supabase
          .from('customers')
          .select('*')
          .eq('is_active', true)
          .order('farm_name'),
        supabase
          .from('fields')
          .select('id, field_name, customer_id')
          .order('field_name'),
        supabase
          .from('blend_ticket_to_order_items')
          .select('*, order:orders(id, order_number, status, customer_id, total_price)')
          .eq('blend_ticket_id', id!)
      ]);

      if (ticketResult.error) throw ticketResult.error;
      if (imagesResult.error) throw imagesResult.error;
      if (productsResult.error) throw productsResult.error;

      setTicket(ticketResult.data);

      const fetchedImages = imagesResult.data || [];
      const imagesWithSignedUrls = await Promise.all(
        fetchedImages.map(async (img: any) => {
          if (img.storage_path) {
            const { data } = await supabase.storage
              .from('blend-ticket-images')
              .createSignedUrl(img.storage_path, 3600);
            return { ...img, image_url: data?.signedUrl || img.image_url };
          }
          return img;
        })
      );
      setImages(imagesWithSignedUrls);
      setProducts(productsResult.data || []);
      setAllProducts(allProductsResult.data || []);
      setCustomers(customersResult.data || []);
      setFields(fieldsResult.data || []);
      setLinkedOrders(linkedResult.data || []);

      setFormData({
        customer_id: ticketResult.data.customer_id || '',
        ticket_date: ticketResult.data.ticket_date || '',
        ticket_time: ticketResult.data.ticket_time || '',
        job_number: ticketResult.data.job_number || '',
        invoice_number: ticketResult.data.invoice_number || '',
        driver_name: ticketResult.data.driver_name || '',
        applicator_name: ticketResult.data.applicator_name || '',
        mixer_name: ticketResult.data.mixer_name || '',
        tank_number: ticketResult.data.tank_number || '',
        vehicle_info: ticketResult.data.vehicle_info || '',
        field_names: ticketResult.data.field_names || '',
        total_acres: ticketResult.data.total_acres?.toString() || '',
        application_rate: ticketResult.data.application_rate || '',
        total_volume: ticketResult.data.total_volume?.toString() || '',
        total_volume_unit: ticketResult.data.total_volume_unit || '',
        notes: ticketResult.data.notes || '',
      });
      // Mark initial load complete so future changes trigger isDirty
      requestAnimationFrame(() => { initialLoadDone.current = true; });
    } catch (error) {
      console.error('Error loading ticket:', error);
    } finally {
      setLoading(false);
    }
  }

  // Track dirty state from form changes
  useEffect(() => {
    if (initialLoadDone.current) setIsDirty(true);
  }, [formData, products]);

  async function handleSave() {
    if (!ticket) return;

    setSaving(true);
    try {
      const ticketPayload = {
        customer_id: formData.customer_id || null,
        ticket_date: formData.ticket_date || null,
        ticket_time: formData.ticket_time || null,
        job_number: formData.job_number || null,
        invoice_number: formData.invoice_number || null,
        driver_name: formData.driver_name || null,
        applicator_name: formData.applicator_name || null,
        mixer_name: formData.mixer_name || null,
        tank_number: formData.tank_number || null,
        vehicle_info: formData.vehicle_info || null,
        field_names: formData.field_names || null,
        total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
        application_rate: formData.application_rate || null,
        total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
        total_volume_unit: formData.total_volume_unit || null,
        notes: formData.notes || null,
      };

      const productsPayload = products.map(p => ({
        id: p.id,
        product_id: p.product_id,
        product_name: p.product_name,
        quantity: p.quantity,
        unit: p.unit,
        lot_number: p.lot_number,
        rate_per_acre: p.rate_per_acre,
        rate_per_acre_unit: p.rate_per_acre_unit,
      }));

      const saveKey = generateIdempotencyKey('save_blend_ticket', profile!.id);
      const { error } = await supabase.rpc('save_blend_ticket', {
        p_ticket_id: ticket.id,
        p_ticket_payload: ticketPayload,
        p_products: productsPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: saveKey,
      });
      if (error) throw error;

      setIsDirty(false);
      await loadTicketData();
    } catch (error: any) {
      console.error('Error saving ticket:', error);
      toast('error', error.message || 'Operation failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    if (!ticket || !profile) return;
    if (!confirm('Approve this blend ticket?')) return;

    try {
      const approveResult = await supabase
        .from('blend_tickets')
        .update({
          review_status: 'approved',
          reviewed_by: profile.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select();
      checkMutationResult(approveResult, 'Approve blend ticket');
      logActivity('blend_ticket_approved', `Blend ticket ${ticket.ticket_number} approved`, profile.id, 'blend_ticket', ticket.id, ticket.customer_id || undefined);

      navigate('/blend-tickets');
    } catch (error: any) {
      console.error('Error approving ticket:', error);
      toast('error', error.message || 'Operation failed');
    }
  }

  async function handleReject() {
    if (!ticket || !profile) return;
    if (!confirm('Reject this blend ticket?')) return;

    try {
      const rejectResult = await supabase
        .from('blend_tickets')
        .update({
          review_status: 'rejected',
          reviewed_by: profile.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select();
      checkMutationResult(rejectResult, 'Reject blend ticket');
      logActivity('blend_ticket_rejected', `Blend ticket ${ticket.ticket_number} rejected`, profile.id, 'blend_ticket', ticket.id, ticket.customer_id || undefined);

      navigate('/blend-tickets');
    } catch (error: any) {
      console.error('Error rejecting ticket:', error);
      toast('error', error.message || 'Operation failed');
    }
  }

  function updateProduct(index: number, field: keyof BlendTicketProduct, value: any) {
    const updated = [...products];
    updated[index] = { ...updated[index], [field]: value };
    setProducts(updated);
  }

  async function addProduct() {
    if (!ticket) return;

    const newProduct = {
      blend_ticket_id: ticket.id,
      product_id: null,
      product_name: '',
      quantity: 0,
      unit: null,
      lot_number: null,
      rate_per_acre: null,
      rate_per_acre_unit: null,
      sequence_order: products.length + 1,
      confidence_score: 0,
      manually_corrected: true,
    };

    const { data, error } = await supabase
      .from('blend_ticket_products')
      .insert(newProduct)
      .select()
      .single();

    if (!error && data) {
      setProducts([...products, data]);
    }
  }

  async function removeProduct(index: number) {
    if (!confirm('Remove this product from the ticket?')) return;
    const product = products[index];

    const deleteResult = await supabase
      .from('blend_ticket_products')
      .delete()
      .eq('id', product.id)
      .select();
    checkMutationResult(deleteResult, 'Delete blend ticket product');

    setProducts(products.filter((_, i) => i !== index));
  }

  // Phase 3: Order linkage handlers
  async function openLinkModal() {
    if (!ticket?.customer_id) {
      toast('error', 'Please assign a customer before linking to an order');
      return;
    }
    // Load orders for the same customer
    const { data, error } = await supabase
      .from('orders')
      .select('*, items:order_items(*)')
      .eq('customer_id', ticket.customer_id)
      .is('deleted_at', null)
      .in('status', ['confirmed', 'partially_fulfilled'])
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      toast('error', 'Failed to load orders');
      return;
    }
    setAvailableOrders(data || []);
    setSelectedOrderId('');
    setShowLinkModal(true);
  }

  async function handleLinkToOrder() {
    if (!ticket || !selectedOrderId || !profile) return;
    setLinking(true);
    try {
      const linkKey = generateIdempotencyKey('link_blend_ticket_to_order', profile.id);
      const { data, error } = await supabase.rpc('link_blend_ticket_to_order', {
        p_blend_ticket_id: ticket.id,
        p_order_id: selectedOrderId,
        p_performed_by: profile.id,
        p_idempotency_key: linkKey,
      });
      if (error) throw error;
      const result = assertRpcResult<any>(data, 'link_blend_ticket_to_order');
      if (!result.success) throw new Error(result.error);
      toast('success', `Linked to order ${result.order_number} (${result.items_linked} items matched)`);
      setShowLinkModal(false);
      await loadTicketData();
    } catch (err: any) {
      toast('error', err.message || 'Failed to link');
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink() {
    if (!ticket || !profile) return;
    if (!confirm('Unlink this blend ticket from its order? The order itself will not be deleted.')) return;
    try {
      const unlinkKey = generateIdempotencyKey('unlink_blend_ticket_from_order', profile.id);
      const { data, error } = await supabase.rpc('unlink_blend_ticket_from_order', {
        p_blend_ticket_id: ticket.id,
        p_performed_by: profile.id,
        p_idempotency_key: unlinkKey,
      });
      if (error) throw error;
      const result = assertRpcResult<any>(data, 'unlink_blend_ticket_from_order');
      if (!result.success) throw new Error(result.error);
      toast('success', 'Blend ticket unlinked from order');
      await loadTicketData();
    } catch (err: any) {
      toast('error', err.message || 'Failed to unlink');
    }
  }

  async function handleCreateOrder() {
    if (!ticket || !profile || !newOrderNumber.trim()) return;
    setLinking(true);
    try {
      const createOrderKey = generateIdempotencyKey('create_order_from_blend_ticket', profile.id);
      const { data, error } = await supabase.rpc('create_order_from_blend_ticket', {
        p_blend_ticket_id: ticket.id,
        p_order_number: newOrderNumber.trim(),
        p_order_date: newOrderDate,
        p_notes: newOrderNotes || null,
        p_performed_by: profile.id,
        p_idempotency_key: createOrderKey,
      });
      if (error) throw error;
      const result = assertRpcResult<any>(data, 'create_order_from_blend_ticket');
      if (!result.success) throw new Error(result.error);
      toast('success', `Order ${result.order_number} created with ${result.items_created} items`);
      setShowCreateOrderModal(false);
      navigate(`/orders/${result.order_id}`);
    } catch (err: any) {
      toast('error', err.message || 'Failed to create order');
    } finally {
      setLinking(false);
    }
  }

  const [creatingAppRecord, setCreatingAppRecord] = useState(false);

  async function handleCreateApplicationRecord() {
    if (!ticket || !profile) return;
    if (!confirm('Create an application record from this approved blend ticket? This action cannot be undone.')) return;

    setCreatingAppRecord(true);
    try {
      const appRecKey = generateIdempotencyKey('create_application_record_from_blend_ticket', profile.id);
      const { data, error } = await supabase.rpc('create_application_record_from_blend_ticket', {
        p_blend_ticket_id: ticket.id,
        p_performed_by: profile.id,
        p_idempotency_key: appRecKey,
      });
      if (error) throw error;
      logActivity('application_record_created', `Application record created from blend ticket ${ticket.ticket_number}`, profile.id, 'blend_ticket', ticket.id, ticket.customer_id || undefined);
      toast('success', 'Application record created successfully');
    } catch (err: any) {
      toast('error', err.message || 'Failed to create application record');
    } finally {
      setCreatingAppRecord(false);
    }
  }

  // Filter fields by customer
  const customerFields = fields.filter(f => !ticket?.customer_id || (f as any).customer_id === ticket.customer_id);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Ticket not found</p>
        <Button className="mt-4" onClick={() => navigate('/blend-tickets')}>
          Back to Tickets
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate('/blend-tickets')}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{ticket.ticket_number}</h1>
            <p className="text-gray-600 mt-1">
              Uploaded {new Date(ticket.created_at).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant={ticket.status === 'completed' ? 'success' : 'warning'}>
            {ticket.status}
          </Badge>
          <Badge variant={ticket.review_status === 'approved' ? 'success' : 'default'}>
            {ticket.review_status}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            Ticket Images
          </h2>

          {images.length > 0 ? (
            <div className="space-y-4">
              <div className="aspect-[4/3] bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
                <img
                  src={images[selectedImageIndex]?.image_url}
                  alt="Ticket"
                  className="w-full h-full object-contain"
                />
              </div>

              {images.length > 1 && (
                <div className="grid grid-cols-4 gap-2">
                  {images.map((image, index) => (
                    <button
                      key={image.id}
                      onClick={() => setSelectedImageIndex(index)}
                      className={`aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                        selectedImageIndex === index
                          ? 'border-blue-500'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <img
                        src={image.image_url}
                        alt={`Ticket ${index + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}

              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-sm text-gray-600">
                  <p>
                    <span className="font-medium">OCR Confidence:</span>{' '}
                    <span
                      className={`font-semibold ${
                        ticket.ocr_confidence_score >= 70
                          ? 'text-green-600'
                          : ticket.ocr_confidence_score >= 50
                          ? 'text-yellow-600'
                          : 'text-red-600'
                      }`}
                    >
                      {ticket.ocr_confidence_score}%
                    </span>
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">No images available</p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Ticket Information</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer
              </label>
              <select
                value={formData.customer_id}
                onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Select Customer</option>
                {customers.map(customer => (
                  <option key={customer.id} value={customer.id}>
                    {customer.farm_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ticket Date
              </label>
              <Input
                type="date"
                value={formData.ticket_date}
                onChange={(e) => setFormData({ ...formData, ticket_date: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ticket Time
              </label>
              <Input
                type="text"
                value={formData.ticket_time}
                onChange={(e) => setFormData({ ...formData, ticket_time: e.target.value })}
                placeholder="e.g. 2:30 PM"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Job #
              </label>
              <Input
                type="text"
                value={formData.job_number}
                onChange={(e) => setFormData({ ...formData, job_number: e.target.value })}
                placeholder="Job / work order number"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Invoice #
              </label>
              <Input
                type="text"
                value={formData.invoice_number}
                onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
                placeholder="Invoice reference"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Driver Name
              </label>
              <Input
                type="text"
                value={formData.driver_name}
                onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
                placeholder="Enter driver name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Applicator Name
              </label>
              <Input
                type="text"
                value={formData.applicator_name}
                onChange={(e) => setFormData({ ...formData, applicator_name: e.target.value })}
                placeholder="Enter applicator name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mixer Name
              </label>
              <Input
                type="text"
                value={formData.mixer_name}
                onChange={(e) => setFormData({ ...formData, mixer_name: e.target.value })}
                placeholder="Person who mixed the blend"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tank #
              </label>
              <Input
                type="text"
                value={formData.tank_number}
                onChange={(e) => setFormData({ ...formData, tank_number: e.target.value })}
                placeholder="Enter tank number"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vehicle
              </label>
              <Input
                type="text"
                value={formData.vehicle_info}
                onChange={(e) => setFormData({ ...formData, vehicle_info: e.target.value })}
                placeholder="Vehicle / rig description"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Field Names / Locations
              </label>
              <Input
                type="text"
                value={formData.field_names}
                onChange={(e) => setFormData({ ...formData, field_names: e.target.value })}
                placeholder="Comma-separated field names"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Acres
              </label>
              <Input
                type="number"
                step="0.01"
                value={formData.total_acres}
                onChange={(e) => setFormData({ ...formData, total_acres: e.target.value })}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Application Rate
              </label>
              <Input
                type="text"
                value={formData.application_rate}
                onChange={(e) => setFormData({ ...formData, application_rate: e.target.value })}
                placeholder="e.g. 10 gal/acre"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Volume
              </label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={formData.total_volume}
                  onChange={(e) => setFormData({ ...formData, total_volume: e.target.value })}
                  placeholder="0"
                />
                <Input
                  type="text"
                  value={formData.total_volume_unit}
                  onChange={(e) => setFormData({ ...formData, total_volume_unit: e.target.value })}
                  placeholder="gal"
                  className="w-24"
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Add notes..."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Products</h2>
          <Button size="sm" onClick={addProduct}>
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        <div className="space-y-4">
          {products.map((product, index) => (
            <div key={product.id} className="grid grid-cols-12 gap-3 items-start p-4 bg-gray-50 rounded-lg">
              <div className="col-span-12 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Product
                </label>
                <select
                  value={product.product_id || ''}
                  onChange={(e) => {
                    updateProduct(index, 'product_id', e.target.value || null);
                    const selectedProduct = allProducts.find(p => p.id === e.target.value);
                    if (selectedProduct) {
                      updateProduct(index, 'product_name', selectedProduct.product_name);
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Product</option>
                  {allProducts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.product_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Qty
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.quantity}
                  onChange={(e) => updateProduct(index, 'quantity', parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Unit
                </label>
                <Input
                  type="text"
                  value={product.unit || ''}
                  onChange={(e) => updateProduct(index, 'unit', e.target.value)}
                  placeholder="gal"
                />
              </div>

              <div className="col-span-4 md:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate/Acre
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.rate_per_acre ?? ''}
                  onChange={(e) => updateProduct(index, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate Unit
                </label>
                <Input
                  type="text"
                  value={product.rate_per_acre_unit || ''}
                  onChange={(e) => updateProduct(index, 'rate_per_acre_unit', e.target.value)}
                  placeholder="oz/ac"
                />
              </div>

              <div className="col-span-6 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Lot Number
                </label>
                <Input
                  type="text"
                  value={product.lot_number || ''}
                  onChange={(e) => updateProduct(index, 'lot_number', e.target.value)}
                  placeholder="Lot #"
                />
              </div>

              <div className="col-span-2 md:col-span-1 flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProduct(index)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {product.confidence_score > 0 && (
                <div className="col-span-12 text-xs text-gray-500">
                  Confidence: {product.confidence_score}%
                  {product.manually_corrected && ' (manually corrected)'}
                </div>
              )}
            </div>
          ))}

          {products.length === 0 && (
            <p className="text-center text-gray-500 py-8">
              No products found. Add products manually or wait for OCR processing.
            </p>
          )}
        </div>
      </Card>

      {/* Phase 3: Order Linkage Section */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Order Linkage
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant={ticket.order_link_status === 'linked' ? 'success' : 'default'}>
              {ticket.order_link_status === 'linked' ? 'Linked' : 'Unlinked'}
            </Badge>
            <Badge variant={
              ticket.payment_status === 'billed' ? 'success' :
              ticket.payment_status === 'prepaid' ? 'info' :
              ticket.payment_status === 'no_charge' ? 'warning' : 'default'
            }>
              {ticket.payment_status.replace('_', ' ')}
            </Badge>
          </div>
        </div>

        {ticket.order_link_status === 'linked' && linkedOrders.length > 0 ? (
          <div className="space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-sm text-green-800 font-medium mb-2">Linked Order</p>
              {(() => {
                const order = (linkedOrders[0] as any)?.order;
                return order ? (
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => navigate(`/orders/${order.id}`)}
                      className="text-crx-green hover:underline font-medium"
                    >
                      {order.order_number}
                    </button>
                    <span className="text-sm text-gray-600">
                      {linkedOrders.length} item(s) mapped
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Order details unavailable</p>
                );
              })()}
            </div>
            <Button variant="secondary" size="sm" onClick={handleUnlink} className="text-red-600">
              <Unlink className="h-4 w-4" />
              Unlink from Order
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              This blend ticket is not linked to any order. Link it to an existing order or create a new one.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={openLinkModal}>
                <Link2 className="h-4 w-4" />
                Link to Existing Order
              </Button>
              <Button size="sm" onClick={() => {
                if (!ticket.customer_id) {
                  toast('error', 'Please assign a customer first');
                  return;
                }
                setNewOrderNumber('');
                setNewOrderDate(new Date().toISOString().split('T')[0]);
                setNewOrderNotes('');
                setShowCreateOrderModal(true);
              }}>
                <ShoppingCart className="h-4 w-4" />
                Create Order from Ticket
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Link to Order Modal */}
      <Modal open={showLinkModal} onClose={() => setShowLinkModal(false)} title="Link to Existing Order" size="large">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select an order for customer <strong>{ticket.customer?.farm_name}</strong> to link this blend ticket to.
            Products will be auto-matched by product ID.
          </p>
          {availableOrders.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              No open orders found for this customer. Create an order first or use "Create Order from Ticket".
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {availableOrders.map((order) => (
                <label
                  key={order.id}
                  className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedOrderId === order.id ? 'border-crx-green bg-crx-green-light' : 'border-gray-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="order"
                    value={order.id}
                    checked={selectedOrderId === order.id}
                    onChange={() => setSelectedOrderId(order.id)}
                    className="text-crx-green focus:ring-crx-green"
                  />
                  <div className="flex-1">
                    <p className="font-medium text-nav-dark">{order.order_number}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(order.order_date).toLocaleDateString()} · {order.status} · ${order.total_price.toFixed(2)}
                      {order.items && ` · ${order.items.length} items`}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowLinkModal(false)}>Cancel</Button>
            <Button onClick={handleLinkToOrder} disabled={!selectedOrderId || linking} loading={linking}>
              <Link2 className="h-4 w-4" />
              Link to Order
            </Button>
          </div>
        </div>
      </Modal>

      {/* Create Order from Blend Ticket Modal */}
      <Modal open={showCreateOrderModal} onClose={() => setShowCreateOrderModal(false)} title="Create Order from Blend Ticket">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            A new order will be created for <strong>{ticket.customer?.farm_name}</strong> using
            the {products.length} product(s) from this blend ticket. Tier pricing will be applied automatically.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Number *</label>
            <Input
              type="text"
              value={newOrderNumber}
              onChange={(e) => setNewOrderNumber(e.target.value)}
              placeholder="e.g., ORD-2026-001"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Date</label>
            <Input
              type="date"
              value={newOrderDate}
              onChange={(e) => setNewOrderDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <textarea
              value={newOrderNotes}
              onChange={(e) => setNewOrderNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Order notes..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCreateOrderModal(false)}>Cancel</Button>
            <Button onClick={handleCreateOrder} disabled={!newOrderNumber.trim() || linking} loading={linking}>
              <ShoppingCart className="h-4 w-4" />
              Create Order
            </Button>
          </div>
        </div>
      </Modal>

      {warnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-yellow-800 font-medium text-sm">
            <AlertCircle className="h-4 w-4" />
            Math Validation Warnings
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-sm text-yellow-700 ml-6">- {w}</p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={() => navigate('/blend-tickets')}>
          Cancel
        </Button>
        {ticket.review_status === 'unreviewed' && (
          <>
            <Button variant="secondary" onClick={handleReject} className="text-red-600 hover:text-red-700">
              <X className="h-4 w-4" />
              Reject
            </Button>
            <Button variant="secondary" onClick={handleApprove} className="text-green-600 hover:text-green-700">
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </>
        )}
        {ticket.review_status === 'approved' && (
          <Button variant="secondary" onClick={handleCreateApplicationRecord} loading={creatingAppRecord}>
            <ClipboardCheck className="h-4 w-4" />
            Create App Record
          </Button>
        )}
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
