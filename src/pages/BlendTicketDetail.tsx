import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Check, X, Plus, Trash2, Image as ImageIcon, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { usePageMeta } from '../hooks/usePageMeta';
import { validateBlendMath } from '../lib/blendMathValidator';
import type { BlendTicket, BlendTicketProduct, BlendTicketImage, Customer, Product } from '../types';

export function BlendTicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  usePageMeta();

  const [ticket, setTicket] = useState<BlendTicket | null>(null);
  const [images, setImages] = useState<BlendTicketImage[]>([]);
  const [products, setProducts] = useState<BlendTicketProduct[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);

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
      const [ticketResult, imagesResult, productsResult, allProductsResult, customersResult] = await Promise.all([
        supabase
          .from('blend_tickets')
          .select(`
            *,
            uploader:profiles!blend_tickets_uploaded_by_fkey(id, full_name),
            reviewer:profiles!blend_tickets_reviewed_by_fkey(id, full_name),
            customer:customers(id, farm_name)
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
          .order('farm_name')
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
    } catch (error) {
      console.error('Error loading ticket:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!ticket) return;

    setSaving(true);
    try {
      const { error: ticketErr, data: ticketData } = await supabase
        .from('blend_tickets')
        .update({
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
          updated_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select();
      if (ticketErr) throw ticketErr;
      if (!ticketData || ticketData.length === 0) throw new Error('Ticket update failed: no rows affected.');

      for (const product of products) {
        const { error: prodErr } = await supabase
          .from('blend_ticket_products')
          .update({
            product_id: product.product_id || null,
            product_name: product.product_name,
            quantity: product.quantity,
            unit: product.unit || null,
            lot_number: product.lot_number || null,
            rate_per_acre: product.rate_per_acre || null,
            rate_per_acre_unit: product.rate_per_acre_unit || null,
            manually_corrected: true,
          })
          .eq('id', product.id)
          .select();
        if (prodErr) throw prodErr;
      }

      await loadTicketData();
    } catch (error) {
      console.error('Error saving ticket:', error);
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    if (!ticket || !profile) return;

    try {
      const { error, data } = await supabase
        .from('blend_tickets')
        .update({
          review_status: 'approved',
          reviewed_by: profile.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('Approve failed: no rows affected.');

      navigate('/blend-tickets');
    } catch (error) {
      console.error('Error approving ticket:', error);
    }
  }

  async function handleReject() {
    if (!ticket || !profile) return;

    try {
      const { error, data } = await supabase
        .from('blend_tickets')
        .update({
          review_status: 'rejected',
          reviewed_by: profile.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', ticket.id)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('Reject failed: no rows affected.');

      navigate('/blend-tickets');
    } catch (error) {
      console.error('Error rejecting ticket:', error);
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
    const product = products[index];

    await supabase
      .from('blend_ticket_products')
      .delete()
      .eq('id', product.id);

    setProducts(products.filter((_, i) => i !== index));
  }

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
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}
