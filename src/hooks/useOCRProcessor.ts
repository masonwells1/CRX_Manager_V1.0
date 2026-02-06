import { useEffect, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import { supabase } from '../lib/db';
import { parseOCRText, fuzzyMatchProduct, fuzzyMatchCustomer } from '../lib/ocrParser';
import type { Product, Customer } from '../types';

const POLL_INTERVAL = 30000;

export function useOCRProcessor(enabled: boolean = true) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!enabled) return;

    initializeWorker();
    startPolling();

    return () => {
      stopPolling();
      cleanupWorker();
    };
  }, [enabled]);

  async function initializeWorker() {
    try {
      const worker = await createWorker('eng');
      workerRef.current = worker;
    } catch (error) {
      console.error('Failed to initialize OCR worker:', error);
    }
  }

  function startPolling() {
    processQueue();
    pollIntervalRef.current = setInterval(() => {
      processQueue();
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
  }

  async function cleanupWorker() {
    if (workerRef.current) {
      await workerRef.current.terminate();
      workerRef.current = null;
    }
  }

  async function processQueue() {
    if (isProcessing || !workerRef.current) return;

    try {
      setIsProcessing(true);

      const { data: queueItems, error: queueError } = await supabase
        .from('ocr_processing_queue')
        .select('*, blend_tickets!inner(*)')
        .eq('status', 'pending')
        .lt('retry_count', 3)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1);

      if (queueError) throw queueError;
      if (!queueItems || queueItems.length === 0) {
        setIsProcessing(false);
        return;
      }

      const queueItem = queueItems[0];

      await supabase
        .from('ocr_processing_queue')
        .update({
          status: 'processing',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', queueItem.id);

      await supabase
        .from('blend_tickets')
        .update({ status: 'processing' })
        .eq('id', queueItem.blend_ticket_id);

      const { data: images, error: imagesError } = await supabase
        .from('blend_ticket_images')
        .select('*')
        .eq('blend_ticket_id', queueItem.blend_ticket_id)
        .order('upload_order');

      if (imagesError) throw imagesError;
      if (!images || images.length === 0) {
        throw new Error('No images found for ticket');
      }

      let combinedText = '';
      for (const image of images) {
        try {
          const response = await fetch(image.image_url);
          const blob = await response.blob();
          const result = await workerRef.current.recognize(blob);
          combinedText += result.data.text + '\n\n';
        } catch (error) {
          console.error(`Failed to process image ${image.id}:`, error);
        }
      }

      if (combinedText.trim().length === 0) {
        throw new Error('No text extracted from images');
      }

      const parsedData = parseOCRText(combinedText);

      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true);

      const { data: customers } = await supabase
        .from('customers')
        .select('*')
        .eq('is_active', true);

      let matchedCustomerId: string | null = null;
      if (parsedData.customerName && customers) {
        const matchedCustomer = fuzzyMatchCustomer(parsedData.customerName, customers);
        if (matchedCustomer) {
          matchedCustomerId = matchedCustomer.id;
        }
      }

      const ticketUpdate: any = {
        status: parsedData.overallConfidence >= 70 ? 'completed' : 'needs_review',
        raw_ocr_text: combinedText,
        ocr_confidence_score: parsedData.overallConfidence,
        ticket_date: parsedData.ticketDate,
        driver_name: parsedData.driverName,
        tank_number: parsedData.tankNumber,
        applicator_name: parsedData.applicatorName,
        signature_detected: parsedData.signatureDetected,
        updated_at: new Date().toISOString(),
      };

      if (matchedCustomerId) {
        ticketUpdate.customer_id = matchedCustomerId;
      }

      await supabase
        .from('blend_tickets')
        .update(ticketUpdate)
        .eq('id', queueItem.blend_ticket_id);

      for (let i = 0; i < parsedData.products.length; i++) {
        const productData = parsedData.products[i];
        let matchedProductId: string | null = null;

        if (products) {
          const matchedProduct = fuzzyMatchProduct(productData.productName, products);
          if (matchedProduct) {
            matchedProductId = matchedProduct.id;
          }
        }

        await supabase.from('blend_ticket_products').insert({
          blend_ticket_id: queueItem.blend_ticket_id,
          product_id: matchedProductId,
          product_name: productData.productName,
          quantity: productData.quantity,
          unit: productData.unit,
          lot_number: productData.lotNumber,
          sequence_order: i + 1,
          confidence_score: productData.confidenceScore,
          manually_corrected: false,
        });
      }

      await supabase
        .from('ocr_processing_queue')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', queueItem.id);

      const uploaderId = queueItem.blend_tickets?.uploaded_by;
      if (uploaderId) {
        await supabase.from('notifications').insert({
          user_id: uploaderId,
          title: 'Blend Ticket Processed',
          message: `Ticket ${queueItem.blend_tickets?.ticket_number} has been processed with ${parsedData.overallConfidence}% confidence`,
          notification_type: 'blend_ticket_processed',
          related_entity_type: 'blend_ticket',
          related_entity_id: queueItem.blend_ticket_id,
        });
      }

      setProcessedCount(prev => prev + 1);

    } catch (error: any) {
      console.error('OCR processing error:', error);

      const { data: queueItems } = await supabase
        .from('ocr_processing_queue')
        .select('*')
        .eq('status', 'processing')
        .limit(1);

      if (queueItems && queueItems.length > 0) {
        const queueItem = queueItems[0];
        const newRetryCount = queueItem.retry_count + 1;

        if (newRetryCount >= queueItem.max_retries) {
          await supabase
            .from('ocr_processing_queue')
            .update({
              status: 'failed',
              error_message: error.message,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', queueItem.id);

          await supabase
            .from('blend_tickets')
            .update({ status: 'failed' })
            .eq('id', queueItem.blend_ticket_id);
        } else {
          await supabase
            .from('ocr_processing_queue')
            .update({
              status: 'pending',
              error_message: error.message,
              retry_count: newRetryCount,
              updated_at: new Date().toISOString(),
            })
            .eq('id', queueItem.id);

          await supabase
            .from('blend_tickets')
            .update({ status: 'pending' })
            .eq('id', queueItem.blend_ticket_id);
        }
      }
    } finally {
      setIsProcessing(false);
    }
  }

  return {
    isProcessing,
    processedCount,
  };
}
