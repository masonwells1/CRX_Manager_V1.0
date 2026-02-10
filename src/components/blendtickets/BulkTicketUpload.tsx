import { useState, useRef } from 'react';
import { Upload, X, Image as ImageIcon, AlertCircle } from 'lucide-react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Input from '../ui/Input';
import { supabase } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { compressImage } from '../../lib/imageCompression';
import type { Customer } from '../../types';

interface ImageFile {
  file: File;
  preview: string;
  id: string;
}

interface BulkTicketUploadProps {
  customers: Customer[];
  onUploadComplete: () => void;
}

export function BulkTicketUpload({ customers, onUploadComplete }: BulkTicketUploadProps) {
  const { profile } = useAuth();
  const [images, setImages] = useState<ImageFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [ticketDate, setTicketDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [driverName, setDriverName] = useState('');
  const [tankNumber, setTankNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

  const MAX_IMAGES = 20;
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const handleFiles = (files: File[]) => {
    const validFiles = files.filter(file => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError('Only JPEG, PNG, and WebP images are allowed');
        return false;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('Files must be smaller than 10MB');
        return false;
      }
      return true;
    });

    if (images.length + validFiles.length > MAX_IMAGES) {
      setError(`Maximum ${MAX_IMAGES} images per upload. You have ${images.length} selected and tried to add ${validFiles.length} more.`);
      return;
    }

    const newImages: ImageFile[] = validFiles.map(file => ({
      file,
      preview: URL.createObjectURL(file),
      id: Math.random().toString(36).substr(2, 9),
    }));

    setImages(prev => [...prev, ...newImages]);
    setError(null);
  };

  const removeImage = (id: string) => {
    setImages(prev => {
      const removed = prev.find(img => img.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter(img => img.id !== id);
    });
  };

  const handleUpload = async () => {
    if (images.length === 0) {
      setError('Please select at least one image');
      return;
    }

    if (!profile) {
      setError('You must be logged in to upload');
      return;
    }

    setIsUploading(true);
    setError(null);
    setUploadProgress(0);

    try {
      const { data: ticketNumberData, error: ticketError } = await supabase
        .rpc('generate_ticket_number');

      if (ticketError) throw ticketError;
      const ticketNumber = ticketNumberData;

      const ticketData: any = {
        ticket_number: ticketNumber,
        uploaded_by: profile!.id,
        upload_date: new Date().toISOString(),
        status: 'pending',
        review_status: 'unreviewed',
        ocr_confidence_score: 0,
      };

      if (selectedCustomerId) {
        ticketData.customer_id = selectedCustomerId;
      }

      if (ticketDate) {
        ticketData.ticket_date = ticketDate;
      }

      if (driverName) {
        ticketData.driver_name = driverName;
      }

      if (tankNumber) {
        ticketData.tank_number = tankNumber;
      }

      const { data: ticket, error: insertError } = await supabase
        .from('blend_tickets')
        .insert(ticketData)
        .select()
        .single();

      if (insertError) throw insertError;

      const folderPath = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${ticket.id}`;

      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        const compressedFile = await compressImage(image.file);
        const fileExt = compressedFile.name.split('.').pop();
        const fileName = `${i + 1}.${fileExt}`;
        const filePath = `${folderPath}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('blend-ticket-images')
          .upload(filePath, compressedFile);

        if (uploadError) throw uploadError;

        const { data: urlData } = await supabase.storage
          .from('blend-ticket-images')
          .createSignedUrl(filePath, 60 * 60 * 24 * 365);

        await supabase.from('blend_ticket_images').insert({
          blend_ticket_id: ticket.id,
          storage_path: filePath,
          image_url: urlData?.signedUrl || filePath,
          file_size: compressedFile.size,
          mime_type: compressedFile.type,
          upload_order: i + 1,
        });

        setUploadProgress(Math.round(((i + 1) / images.length) * 100));
      }

      await supabase.from('ocr_processing_queue').insert({
        blend_ticket_id: ticket.id,
        status: 'pending',
        priority: 0,
        retry_count: 0,
        max_retries: 3,
      });

      images.forEach(img => URL.revokeObjectURL(img.preview));
      setImages([]);
      setSelectedCustomerId('');
      setTicketDate(new Date().toISOString().split('T')[0]);
      setDriverName('');
      setTankNumber('');
      setUploadProgress(0);

      onUploadComplete();

      setError(null);
    } catch (err: any) {
      console.error('Upload error:', err);
      setError(err.message || 'Failed to upload images');
    } finally {
      setIsUploading(false);
    }
  };

  const totalSize = images.reduce((sum, img) => sum + img.file.size, 0);
  const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

  return (
    <Card className="p-6">
      <h2 className="text-xl font-semibold mb-4">Upload Blend Ticket</h2>

      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Customer (Optional)
            </label>
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              disabled={isUploading}
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
              Ticket Date (Optional)
            </label>
            <Input
              type="date"
              value={ticketDate}
              onChange={(e) => setTicketDate(e.target.value)}
              disabled={isUploading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Driver Name (Optional)
            </label>
            <Input
              type="text"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              placeholder="Enter driver name"
              disabled={isUploading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tank Number (Optional)
            </label>
            <Input
              type="text"
              value={tankNumber}
              onChange={(e) => setTankNumber(e.target.value)}
              placeholder="Enter tank number"
              disabled={isUploading}
            />
          </div>
        </div>

        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-300 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileSelect}
            className="hidden"
            disabled={isUploading}
          />

          <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <p className="text-lg font-medium text-gray-900 mb-2">
            Drop images here or click to upload
          </p>
          <p className="text-sm text-gray-500 mb-4">
            JPEG, PNG, WebP up to 10MB each (max {MAX_IMAGES} images)
          </p>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            Select Images
          </Button>
        </div>

        {images.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">
                {images.length} image{images.length !== 1 ? 's' : ''} selected ({totalSizeMB} MB)
              </p>
              {!isUploading && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    images.forEach(img => URL.revokeObjectURL(img.preview));
                    setImages([]);
                  }}
                >
                  Clear All
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {images.map((image) => (
                <div key={image.id} className="relative group">
                  <div className="aspect-square rounded-lg overflow-hidden bg-gray-100 border border-gray-200">
                    <img
                      src={image.preview}
                      alt="Preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {!isUploading && (
                    <button
                      onClick={() => removeImage(image.id)}
                      className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded">
                    {(image.file.size / 1024).toFixed(0)} KB
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isUploading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Uploading images...</span>
              <span className="font-medium">{uploadProgress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              images.forEach(img => URL.revokeObjectURL(img.preview));
              setImages([]);
              setError(null);
            }}
            disabled={isUploading || images.length === 0}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={isUploading || images.length === 0}
          >
            {isUploading ? 'Uploading...' : `Upload ${images.length} Image${images.length !== 1 ? 's' : ''}`}
          </Button>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex gap-2">
            <ImageIcon className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">Images will be processed in the background</p>
              <p>After upload, OCR will automatically extract product information. You'll receive a notification when processing is complete.</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
