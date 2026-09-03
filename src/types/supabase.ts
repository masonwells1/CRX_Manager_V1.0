export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      accounting_periods: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          notes: string | null
          period_end: string
          period_start: string
          status: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          period_end: string
          period_start: string
          status?: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          period_end?: string
          period_start?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_periods_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_feed: {
        Row: {
          created_at: string
          customer_id: string | null
          description: string
          event_type: string
          id: string
          performed_by: string
          related_entity_id: string | null
          related_entity_type: string | null
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          description?: string
          event_type?: string
          id?: string
          performed_by: string
          related_entity_id?: string | null
          related_entity_type?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          description?: string
          event_type?: string
          id?: string
          performed_by?: string
          related_entity_id?: string | null
          related_entity_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_feed_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_feed_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_sets: {
        Row: {
          check_number: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          entity_id: string
          entity_type: string
          id: string
          is_active: boolean
          notes: string | null
          payment_date: string | null
          payment_method: string | null
          reference_number: string | null
          season: number | null
          total_allocated_cents: number | null
          total_payment_cents: number | null
          updated_at: string | null
          version: number
        }
        Insert: {
          check_number?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          entity_id: string
          entity_type: string
          id?: string
          is_active?: boolean
          notes?: string | null
          payment_date?: string | null
          payment_method?: string | null
          reference_number?: string | null
          season?: number | null
          total_allocated_cents?: number | null
          total_payment_cents?: number | null
          updated_at?: string | null
          version?: number
        }
        Update: {
          check_number?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          payment_date?: string | null
          payment_method?: string | null
          reference_number?: string | null
          season?: number | null
          total_allocated_cents?: number | null
          total_payment_cents?: number | null
          updated_at?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "allocation_sets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          setting_key: string
          setting_value: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          setting_key: string
          setting_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          setting_key?: string
          setting_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_record_fields: {
        Row: {
          acres: number
          application_record_id: string
          created_at: string
          field_id: string
          id: string
          sort_order: number
        }
        Insert: {
          acres: number
          application_record_id: string
          created_at?: string
          field_id: string
          id?: string
          sort_order?: number
        }
        Update: {
          acres?: number
          application_record_id?: string
          created_at?: string
          field_id?: string
          id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "application_record_fields_application_record_id_fkey"
            columns: ["application_record_id"]
            isOneToOne: false
            referencedRelation: "application_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_record_fields_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      application_record_lots: {
        Row: {
          application_record_id: string
          created_at: string
          created_by: string | null
          id: string
          lot_number: string
          notes: string | null
          product_id: string
          quantity_from_lot: number | null
          source_receiving_record_id: string | null
          unit: string | null
        }
        Insert: {
          application_record_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          lot_number: string
          notes?: string | null
          product_id: string
          quantity_from_lot?: number | null
          source_receiving_record_id?: string | null
          unit?: string | null
        }
        Update: {
          application_record_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          lot_number?: string
          notes?: string | null
          product_id?: string
          quantity_from_lot?: number | null
          source_receiving_record_id?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_record_lots_application_record_id_fkey"
            columns: ["application_record_id"]
            isOneToOne: false
            referencedRelation: "application_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_record_lots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_record_lots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_record_lots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_record_lots_source_receiving_record_id_fkey"
            columns: ["source_receiving_record_id"]
            isOneToOne: false
            referencedRelation: "receiving_records"
            referencedColumns: ["id"]
          },
        ]
      }
      application_records: {
        Row: {
          application_date: string
          application_time: string | null
          applicator_id: string | null
          applicator_license_number: string | null
          applicator_name: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          field_id: string | null
          id: string
          invoice_id: string | null
          notes: string | null
          product_data: Json
          record_number: string
          season: number | null
          source_id: string
          source_type: string
          total_acres: number | null
          total_volume: number | null
          total_volume_unit: string | null
          updated_at: string
          vehicle_id: string | null
          weather_conditions: Json | null
        }
        Insert: {
          application_date: string
          application_time?: string | null
          applicator_id?: string | null
          applicator_license_number?: string | null
          applicator_name?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          field_id?: string | null
          id?: string
          invoice_id?: string | null
          notes?: string | null
          product_data?: Json
          record_number: string
          season?: number | null
          source_id: string
          source_type: string
          total_acres?: number | null
          total_volume?: number | null
          total_volume_unit?: string | null
          updated_at?: string
          vehicle_id?: string | null
          weather_conditions?: Json | null
        }
        Update: {
          application_date?: string
          application_time?: string | null
          applicator_id?: string | null
          applicator_license_number?: string | null
          applicator_name?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          field_id?: string | null
          id?: string
          invoice_id?: string | null
          notes?: string | null
          product_data?: Json
          record_number?: string
          season?: number | null
          source_id?: string
          source_type?: string
          total_acres?: number | null
          total_volume?: number | null
          total_volume_unit?: string | null
          updated_at?: string
          vehicle_id?: string | null
          weather_conditions?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "application_records_applicator_id_fkey"
            columns: ["applicator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_records_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_records_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_records_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_services: {
        Row: {
          cost_per_acre_cents: number
          created_at: string
          created_by: string | null
          default_rate_per_acre_cents: number
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          cost_per_acre_cents?: number
          created_at?: string
          created_by?: string | null
          default_rate_per_acre_cents?: number
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          cost_per_acre_cents?: number
          created_at?: string
          created_by?: string | null
          default_rate_per_acre_cents?: number
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_services_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_services_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      applicator_licenses: {
        Row: {
          certification_categories: string[] | null
          created_at: string
          customer_id: string | null
          expiry_date: string
          holder_name: string
          id: string
          is_active: boolean
          issued_date: string | null
          license_number: string
          license_type: string
          notes: string | null
          profile_id: string | null
          state: string
          updated_at: string
        }
        Insert: {
          certification_categories?: string[] | null
          created_at?: string
          customer_id?: string | null
          expiry_date: string
          holder_name: string
          id?: string
          is_active?: boolean
          issued_date?: string | null
          license_number: string
          license_type?: string
          notes?: string | null
          profile_id?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          certification_categories?: string[] | null
          created_at?: string
          customer_id?: string | null
          expiry_date?: string
          holder_name?: string
          id?: string
          is_active?: boolean
          issued_date?: string | null
          license_number?: string
          license_type?: string
          notes?: string | null
          profile_id?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applicator_licenses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applicator_licenses_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ar_reminder_tracking: {
        Row: {
          created_at: string | null
          customer_id: string
          email_log_id: string | null
          id: string
          reminder_level: number
          sent_date: string
        }
        Insert: {
          created_at?: string | null
          customer_id: string
          email_log_id?: string | null
          id?: string
          reminder_level: number
          sent_date?: string
        }
        Update: {
          created_at?: string | null
          customer_id?: string
          email_log_id?: string | null
          id?: string
          reminder_level?: number
          sent_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "ar_reminder_tracking_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_reminder_tracking_email_log_id_fkey"
            columns: ["email_log_id"]
            isOneToOne: false
            referencedRelation: "email_log"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_runs: {
        Row: {
          failed: Json
          id: number
          ran_at: string
          rows_backed_up: number
          succeeded: boolean
          tables_backed_up: number
        }
        Insert: {
          failed?: Json
          id?: never
          ran_at?: string
          rows_backed_up: number
          succeeded: boolean
          tables_backed_up: number
        }
        Update: {
          failed?: Json
          id?: never
          ran_at?: string
          rows_backed_up?: number
          succeeded?: boolean
          tables_backed_up?: number
        }
        Relationships: []
      }
      backup_snapshots: {
        Row: {
          data: Json
          id: number
          row_count: number
          table_name: string
          taken_at: string
        }
        Insert: {
          data: Json
          id?: never
          row_count: number
          table_name: string
          taken_at?: string
        }
        Update: {
          data?: Json
          id?: never
          row_count?: number
          table_name?: string
          taken_at?: string
        }
        Relationships: []
      }
      blend_recipe_items: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          price_per_unit_cents: number
          product_id: string
          product_name: string
          quantity: number
          rate_per_acre: number | null
          recipe_id: string
          sort_order: number
          unit: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          price_per_unit_cents?: number
          product_id: string
          product_name?: string
          quantity?: number
          rate_per_acre?: number | null
          recipe_id: string
          sort_order?: number
          unit?: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          price_per_unit_cents?: number
          product_id?: string
          product_name?: string
          quantity?: number
          rate_per_acre?: number | null
          recipe_id?: string
          sort_order?: number
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "blend_recipe_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_recipe_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_recipe_items_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "blend_recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_recipes: {
        Row: {
          created_at: string
          created_by: string
          crop_type: string | null
          deleted_at: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          recipe_type: string
          timing: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          crop_type?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          recipe_type?: string
          timing?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          crop_type?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          recipe_type?: string
          timing?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      blend_ticket_fields: {
        Row: {
          actual_acres: number | null
          applied_at: string | null
          applied_by: string | null
          blend_ticket_id: string
          created_at: string | null
          customer_id: string | null
          field_id: string
          id: string
          notes: string | null
          planned_acres: number | null
          sort_order: number | null
        }
        Insert: {
          actual_acres?: number | null
          applied_at?: string | null
          applied_by?: string | null
          blend_ticket_id: string
          created_at?: string | null
          customer_id?: string | null
          field_id: string
          id?: string
          notes?: string | null
          planned_acres?: number | null
          sort_order?: number | null
        }
        Update: {
          actual_acres?: number | null
          applied_at?: string | null
          applied_by?: string | null
          blend_ticket_id?: string
          created_at?: string | null
          customer_id?: string | null
          field_id?: string
          id?: string
          notes?: string | null
          planned_acres?: number | null
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_ticket_fields_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_fields_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_fields_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_fields_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_ticket_images: {
        Row: {
          blend_ticket_id: string
          created_at: string
          file_size: number
          height: number | null
          id: string
          image_url: string
          mime_type: string
          storage_path: string
          upload_order: number
          width: number | null
        }
        Insert: {
          blend_ticket_id: string
          created_at?: string
          file_size?: number
          height?: number | null
          id?: string
          image_url: string
          mime_type?: string
          storage_path: string
          upload_order?: number
          width?: number | null
        }
        Update: {
          blend_ticket_id?: string
          created_at?: string
          file_size?: number
          height?: number | null
          id?: string
          image_url?: string
          mime_type?: string
          storage_path?: string
          upload_order?: number
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_ticket_images_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_ticket_products: {
        Row: {
          blend_ticket_id: string
          confidence_score: number | null
          created_at: string
          id: string
          lot_number: string | null
          manually_corrected: boolean | null
          product_id: string | null
          product_name: string
          quantity: number
          rate_per_acre: number | null
          rate_per_acre_unit: string | null
          sequence_order: number
          unit: string | null
          unit_cost_cents: number | null
          unit_price_cents: number | null
        }
        Insert: {
          blend_ticket_id: string
          confidence_score?: number | null
          created_at?: string
          id?: string
          lot_number?: string | null
          manually_corrected?: boolean | null
          product_id?: string | null
          product_name?: string
          quantity?: number
          rate_per_acre?: number | null
          rate_per_acre_unit?: string | null
          sequence_order?: number
          unit?: string | null
          unit_cost_cents?: number | null
          unit_price_cents?: number | null
        }
        Update: {
          blend_ticket_id?: string
          confidence_score?: number | null
          created_at?: string
          id?: string
          lot_number?: string | null
          manually_corrected?: boolean | null
          product_id?: string | null
          product_name?: string
          quantity?: number
          rate_per_acre?: number | null
          rate_per_acre_unit?: string | null
          sequence_order?: number
          unit?: string | null
          unit_cost_cents?: number | null
          unit_price_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_ticket_products_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_ticket_to_order_items: {
        Row: {
          blend_ticket_id: string
          blend_ticket_product_id: string
          created_at: string
          created_by: string
          id: string
          notes: string | null
          order_id: string
          order_item_id: string
          quantity_applied: number | null
        }
        Insert: {
          blend_ticket_id: string
          blend_ticket_product_id: string
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          order_id: string
          order_item_id: string
          quantity_applied?: number | null
        }
        Update: {
          blend_ticket_id?: string
          blend_ticket_product_id?: string
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          order_id?: string
          order_item_id?: string
          quantity_applied?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_ticket_to_order_items_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_to_order_items_blend_ticket_product_id_fkey"
            columns: ["blend_ticket_product_id"]
            isOneToOne: false
            referencedRelation: "blend_ticket_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_to_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_ticket_to_order_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      blend_tickets: {
        Row: {
          application_rate: string | null
          application_service_id: string | null
          applicator_id: string | null
          applicator_name: string | null
          created_at: string
          customer_id: string | null
          deleted_at: string | null
          driver_name: string | null
          field_id: string | null
          field_names: string | null
          id: string
          invoice_number: string | null
          job_id: string | null
          job_number: string | null
          manually_corrected_fields: string[]
          mixer_name: string | null
          notes: string | null
          ocr_confidence_score: number | null
          order_link_status: string
          payment_status: string
          raw_ocr_text: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          salesman_id: string | null
          season: number | null
          signature_detected: boolean | null
          source: string
          status: string
          tank_number: string | null
          ticket_date: string | null
          ticket_number: string
          ticket_time: string | null
          total_acres: number | null
          total_volume: number | null
          total_volume_unit: string | null
          updated_at: string
          upload_date: string
          uploaded_by: string
          vehicle_id: string | null
          vehicle_info: string | null
        }
        Insert: {
          application_rate?: string | null
          application_service_id?: string | null
          applicator_id?: string | null
          applicator_name?: string | null
          created_at?: string
          customer_id?: string | null
          deleted_at?: string | null
          driver_name?: string | null
          field_id?: string | null
          field_names?: string | null
          id?: string
          invoice_number?: string | null
          job_id?: string | null
          job_number?: string | null
          manually_corrected_fields?: string[]
          mixer_name?: string | null
          notes?: string | null
          ocr_confidence_score?: number | null
          order_link_status?: string
          payment_status?: string
          raw_ocr_text?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          salesman_id?: string | null
          season?: number | null
          signature_detected?: boolean | null
          source?: string
          status?: string
          tank_number?: string | null
          ticket_date?: string | null
          ticket_number: string
          ticket_time?: string | null
          total_acres?: number | null
          total_volume?: number | null
          total_volume_unit?: string | null
          updated_at?: string
          upload_date?: string
          uploaded_by: string
          vehicle_id?: string | null
          vehicle_info?: string | null
        }
        Update: {
          application_rate?: string | null
          application_service_id?: string | null
          applicator_id?: string | null
          applicator_name?: string | null
          created_at?: string
          customer_id?: string | null
          deleted_at?: string | null
          driver_name?: string | null
          field_id?: string | null
          field_names?: string | null
          id?: string
          invoice_number?: string | null
          job_id?: string | null
          job_number?: string | null
          manually_corrected_fields?: string[]
          mixer_name?: string | null
          notes?: string | null
          ocr_confidence_score?: number | null
          order_link_status?: string
          payment_status?: string
          raw_ocr_text?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          salesman_id?: string | null
          season?: number | null
          signature_detected?: boolean | null
          source?: string
          status?: string
          tank_number?: string | null
          ticket_date?: string | null
          ticket_number?: string
          ticket_time?: string | null
          total_acres?: number | null
          total_volume?: number | null
          total_volume_unit?: string | null
          updated_at?: string
          upload_date?: string
          uploaded_by?: string
          vehicle_id?: string | null
          vehicle_info?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blend_tickets_application_service_id_fkey"
            columns: ["application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_applicator_id_fkey"
            columns: ["applicator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_salesman_id_fkey"
            columns: ["salesman_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blend_tickets_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_payment_items: {
        Row: {
          amount: number
          commission_id: string
          commission_payment_id: string
          created_at: string
          id: string
        }
        Insert: {
          amount: number
          commission_id: string
          commission_payment_id: string
          created_at?: string
          id?: string
        }
        Update: {
          amount?: number
          commission_id?: string
          commission_payment_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commission_payment_items_commission_id_fkey"
            columns: ["commission_id"]
            isOneToOne: false
            referencedRelation: "commissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_payment_items_commission_payment_id_fkey"
            columns: ["commission_payment_id"]
            isOneToOne: false
            referencedRelation: "commission_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_payments: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          payment_date: string
          payment_method: string | null
          payment_number: string
          posted_at: string | null
          posted_by: string | null
          recipient_id: string
          reference_number: string | null
          season: number | null
          status: string
          total_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: string | null
          payment_number: string
          posted_at?: string | null
          posted_by?: string | null
          recipient_id: string
          reference_number?: string | null
          season?: number | null
          status?: string
          total_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: string | null
          payment_number?: string
          posted_at?: string | null
          posted_by?: string | null
          recipient_id?: string
          reference_number?: string | null
          season?: number | null
          status?: string
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commission_payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_payments_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_payments_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      commissions: {
        Row: {
          commission_amount: number
          created_at: string
          customer_id: string
          customer_name: string | null
          deleted_at: string | null
          id: string
          invoice_id: string | null
          job_id: string | null
          order_date: string | null
          order_id: string | null
          order_number: string | null
          order_profit: number
          paid_date: string | null
          paid_note: string | null
          recipient: string
          recipient_user_id: string | null
          season: number | null
          split_percentage: number
          status: string
        }
        Insert: {
          commission_amount?: number
          created_at?: string
          customer_id: string
          customer_name?: string | null
          deleted_at?: string | null
          id?: string
          invoice_id?: string | null
          job_id?: string | null
          order_date?: string | null
          order_id?: string | null
          order_number?: string | null
          order_profit?: number
          paid_date?: string | null
          paid_note?: string | null
          recipient?: string
          recipient_user_id?: string | null
          season?: number | null
          split_percentage?: number
          status?: string
        }
        Update: {
          commission_amount?: number
          created_at?: string
          customer_id?: string
          customer_name?: string | null
          deleted_at?: string | null
          id?: string
          invoice_id?: string | null
          job_id?: string | null
          order_date?: string | null
          order_id?: string | null
          order_number?: string | null
          order_profit?: number
          paid_date?: string | null
          paid_note?: string | null
          recipient?: string
          recipient_user_id?: string | null
          season?: number | null
          split_percentage?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "commissions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_recipient_user_id_fkey"
            columns: ["recipient_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_history: {
        Row: {
          change_note: string | null
          change_reason: string | null
          change_set_id: string | null
          change_source: string
          changed_at: string
          changed_by: string
          id: string
          new_cost: number | null
          new_pricing_version: number | null
          new_tier1_margin: number | null
          new_tier1_price: number | null
          new_tier2_margin: number | null
          new_tier2_price: number | null
          new_tier3_margin: number | null
          new_tier3_price: number | null
          old_cost: number | null
          old_pricing_version: number | null
          old_tier1_margin: number | null
          old_tier1_price: number | null
          old_tier2_margin: number | null
          old_tier2_price: number | null
          old_tier3_margin: number | null
          old_tier3_price: number | null
          product_id: string
        }
        Insert: {
          change_note?: string | null
          change_reason?: string | null
          change_set_id?: string | null
          change_source: string
          changed_at?: string
          changed_by: string
          id?: string
          new_cost?: number | null
          new_pricing_version?: number | null
          new_tier1_margin?: number | null
          new_tier1_price?: number | null
          new_tier2_margin?: number | null
          new_tier2_price?: number | null
          new_tier3_margin?: number | null
          new_tier3_price?: number | null
          old_cost?: number | null
          old_pricing_version?: number | null
          old_tier1_margin?: number | null
          old_tier1_price?: number | null
          old_tier2_margin?: number | null
          old_tier2_price?: number | null
          old_tier3_margin?: number | null
          old_tier3_price?: number | null
          product_id: string
        }
        Update: {
          change_note?: string | null
          change_reason?: string | null
          change_set_id?: string | null
          change_source?: string
          changed_at?: string
          changed_by?: string
          id?: string
          new_cost?: number | null
          new_pricing_version?: number | null
          new_tier1_margin?: number | null
          new_tier1_price?: number | null
          new_tier2_margin?: number | null
          new_tier2_price?: number | null
          new_tier3_margin?: number | null
          new_tier3_price?: number | null
          old_cost?: number | null
          old_pricing_version?: number | null
          old_tier1_margin?: number | null
          old_tier1_price?: number | null
          old_tier2_margin?: number | null
          old_tier2_price?: number | null
          old_tier3_margin?: number | null
          old_tier3_price?: number | null
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_history_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_history_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_history_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_memo_applications: {
        Row: {
          amount_cents: number
          applied_at: string
          applied_by: string
          credit_memo_id: string
          id: string
          reversal_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
          target_invoice_id: string
        }
        Insert: {
          amount_cents: number
          applied_at?: string
          applied_by: string
          credit_memo_id: string
          id?: string
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          target_invoice_id: string
        }
        Update: {
          amount_cents?: number
          applied_at?: string
          applied_by?: string
          credit_memo_id?: string
          id?: string
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          target_invoice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_memo_applications_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_memo_applications_credit_memo_id_fkey"
            columns: ["credit_memo_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_memo_applications_reversed_by_fkey"
            columns: ["reversed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_memo_applications_target_invoice_id_fkey"
            columns: ["target_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_addresses: {
        Row: {
          address_line: string | null
          city: string | null
          created_at: string
          customer_id: string
          delivery_notes: string | null
          id: string
          is_default: boolean
          label: string
          latitude: number | null
          longitude: number | null
          state: string | null
          zip: string | null
        }
        Insert: {
          address_line?: string | null
          city?: string | null
          created_at?: string
          customer_id: string
          delivery_notes?: string | null
          id?: string
          is_default?: boolean
          label?: string
          latitude?: number | null
          longitude?: number | null
          state?: string | null
          zip?: string | null
        }
        Update: {
          address_line?: string | null
          city?: string | null
          created_at?: string
          customer_id?: string
          delivery_notes?: string | null
          id?: string
          is_default?: boolean
          label?: string
          latitude?: number | null
          longitude?: number | null
          state?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_application_rates: {
        Row: {
          application_service_id: string
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          notes: string | null
          rate_per_acre_cents: number
          season: number
        }
        Insert: {
          application_service_id: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          notes?: string | null
          rate_per_acre_cents: number
          season: number
        }
        Update: {
          application_service_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          notes?: string | null
          rate_per_acre_cents?: number
          season?: number
        }
        Relationships: [
          {
            foreignKeyName: "customer_application_rates_application_service_id_fkey"
            columns: ["application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_application_rates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_application_rates_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_contacts: {
        Row: {
          can_place_orders: boolean
          created_at: string
          customer_id: string
          email: string | null
          id: string
          is_active: boolean
          is_billing_contact: boolean
          is_decision_maker: boolean
          is_primary: boolean
          name: string | null
          notes: string | null
          phone_display: string | null
          phone_e164: string | null
          preferred_contact_method: string | null
          role: string | null
          updated_at: string
        }
        Insert: {
          can_place_orders?: boolean
          created_at?: string
          customer_id: string
          email?: string | null
          id?: string
          is_active?: boolean
          is_billing_contact?: boolean
          is_decision_maker?: boolean
          is_primary?: boolean
          name?: string | null
          notes?: string | null
          phone_display?: string | null
          phone_e164?: string | null
          preferred_contact_method?: string | null
          role?: string | null
          updated_at?: string
        }
        Update: {
          can_place_orders?: boolean
          created_at?: string
          customer_id?: string
          email?: string | null
          id?: string
          is_active?: boolean
          is_billing_contact?: boolean
          is_decision_maker?: boolean
          is_primary?: boolean
          name?: string | null
          notes?: string | null
          phone_display?: string | null
          phone_e164?: string | null
          preferred_contact_method?: string | null
          role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_documents: {
        Row: {
          contact_id: string | null
          created_at: string
          customer_id: string
          deleted_at: string | null
          deleted_by: string | null
          document_type: string
          effective_date: string | null
          expiration_date: string | null
          filename: string
          id: string
          mime_type: string
          notes: string | null
          size_bytes: number
          source: string
          storage_path: string
          updated_at: string
          uploaded_by: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          customer_id: string
          deleted_at?: string | null
          deleted_by?: string | null
          document_type: string
          effective_date?: string | null
          expiration_date?: string | null
          filename: string
          id?: string
          mime_type: string
          notes?: string | null
          size_bytes: number
          source?: string
          storage_path: string
          updated_at?: string
          uploaded_by: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          customer_id?: string
          deleted_at?: string | null
          deleted_by?: string | null
          document_type?: string
          effective_date?: string | null
          expiration_date?: string | null
          filename?: string
          id?: string
          mime_type?: string
          notes?: string | null
          size_bytes?: number
          source?: string
          storage_path?: string
          updated_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_documents_customer_contact_fkey"
            columns: ["customer_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "customer_contacts"
            referencedColumns: ["customer_id", "id"]
          },
          {
            foreignKeyName: "customer_documents_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_documents_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_facts: {
        Row: {
          category: string
          confidence: number | null
          created_at: string
          customer_id: string
          entered_by: string | null
          expires_at: string | null
          fact_key: string
          id: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          source_interaction_id: string | null
          status: string
          superseded_at: string | null
          superseded_by: string | null
          updated_at: string
          value_json: Json | null
          value_text: string | null
        }
        Insert: {
          category: string
          confidence?: number | null
          created_at?: string
          customer_id: string
          entered_by?: string | null
          expires_at?: string | null
          fact_key: string
          id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          source_interaction_id?: string | null
          status?: string
          superseded_at?: string | null
          superseded_by?: string | null
          updated_at?: string
          value_json?: Json | null
          value_text?: string | null
        }
        Update: {
          category?: string
          confidence?: number | null
          created_at?: string
          customer_id?: string
          entered_by?: string | null
          expires_at?: string | null
          fact_key?: string
          id?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          source_interaction_id?: string | null
          status?: string
          superseded_at?: string | null
          superseded_by?: string | null
          updated_at?: string
          value_json?: Json | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_facts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_facts_customer_interaction_fkey"
            columns: ["customer_id", "source_interaction_id"]
            isOneToOne: false
            referencedRelation: "customer_interactions"
            referencedColumns: ["customer_id", "id"]
          },
          {
            foreignKeyName: "customer_facts_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_facts_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_facts_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "customer_facts"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_interactions: {
        Row: {
          contact_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          direction: string | null
          duration_seconds: number | null
          external_call_id: string | null
          id: string
          interaction_type: string
          occurred_at: string
          outcome: string | null
          owner_user_id: string | null
          provider: string | null
          source: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          direction?: string | null
          duration_seconds?: number | null
          external_call_id?: string | null
          id?: string
          interaction_type: string
          occurred_at?: string
          outcome?: string | null
          owner_user_id?: string | null
          provider?: string | null
          source?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          direction?: string | null
          duration_seconds?: number | null
          external_call_id?: string | null
          id?: string
          interaction_type?: string
          occurred_at?: string
          outcome?: string | null
          owner_user_id?: string | null
          provider?: string | null
          source?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_interactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_interactions_customer_contact_fkey"
            columns: ["customer_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "customer_contacts"
            referencedColumns: ["customer_id", "id"]
          },
          {
            foreignKeyName: "customer_interactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_interactions_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          account_number: string | null
          assigned_sales_rep: string | null
          assigned_tier: number
          billing_address: string | null
          city: string | null
          contact_name: string | null
          corn_acres: number | null
          created_at: string
          credit_limit_cents: number | null
          crops: string[]
          default_application_service_id: string | null
          default_commission_split: Json | null
          email: string | null
          farm_name: string
          finance_charge_enabled: boolean | null
          finance_charge_grace_days: number | null
          finance_charge_rate: number | null
          id: string
          is_active: boolean
          notes: string | null
          other_acres: number | null
          parent_customer_id: string | null
          payment_terms: string | null
          phone: string | null
          prepay_balance_cents: number
          row_version: number
          shipping_address: string | null
          soybean_acres: number | null
          state: string | null
          total_acres: number | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          account_number?: string | null
          assigned_sales_rep?: string | null
          assigned_tier?: number
          billing_address?: string | null
          city?: string | null
          contact_name?: string | null
          corn_acres?: number | null
          created_at?: string
          credit_limit_cents?: number | null
          crops?: string[]
          default_application_service_id?: string | null
          default_commission_split?: Json | null
          email?: string | null
          farm_name: string
          finance_charge_enabled?: boolean | null
          finance_charge_grace_days?: number | null
          finance_charge_rate?: number | null
          id?: string
          is_active?: boolean
          notes?: string | null
          other_acres?: number | null
          parent_customer_id?: string | null
          payment_terms?: string | null
          phone?: string | null
          prepay_balance_cents?: number
          row_version?: number
          shipping_address?: string | null
          soybean_acres?: number | null
          state?: string | null
          total_acres?: number | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          account_number?: string | null
          assigned_sales_rep?: string | null
          assigned_tier?: number
          billing_address?: string | null
          city?: string | null
          contact_name?: string | null
          corn_acres?: number | null
          created_at?: string
          credit_limit_cents?: number | null
          crops?: string[]
          default_application_service_id?: string | null
          default_commission_split?: Json | null
          email?: string | null
          farm_name?: string
          finance_charge_enabled?: boolean | null
          finance_charge_grace_days?: number | null
          finance_charge_rate?: number | null
          id?: string
          is_active?: boolean
          notes?: string | null
          other_acres?: number | null
          parent_customer_id?: string | null
          payment_terms?: string | null
          phone?: string | null
          prepay_balance_cents?: number
          row_version?: number
          shipping_address?: string | null
          soybean_acres?: number | null
          state?: string | null
          total_acres?: number | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_assigned_sales_rep_fkey"
            columns: ["assigned_sales_rep"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_default_application_service_id_fkey"
            columns: ["default_application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_parent_customer_id_fkey"
            columns: ["parent_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      cycle_count_items: {
        Row: {
          counted_at: string | null
          counted_by: string | null
          counted_qty: number | null
          created_at: string
          cycle_count_id: string
          expected_qty: number
          id: string
          inventory_id: string | null
          is_counted: boolean
          notes: string | null
          product_id: string
          variance: number | null
          variance_pct: number | null
        }
        Insert: {
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          cycle_count_id: string
          expected_qty?: number
          id?: string
          inventory_id?: string | null
          is_counted?: boolean
          notes?: string | null
          product_id: string
          variance?: number | null
          variance_pct?: number | null
        }
        Update: {
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          cycle_count_id?: string
          expected_qty?: number
          id?: string
          inventory_id?: string | null
          is_counted?: boolean
          notes?: string | null
          product_id?: string
          variance?: number | null
          variance_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cycle_count_items_cycle_count_id_fkey"
            columns: ["cycle_count_id"]
            isOneToOne: false
            referencedRelation: "cycle_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycle_count_items_inventory_id_fkey"
            columns: ["inventory_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycle_count_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycle_count_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      cycle_counts: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          count_number: string
          created_at: string
          id: string
          initiated_by: string
          notes: string | null
          started_at: string
          status: string
          warehouse: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          count_number: string
          created_at?: string
          id?: string
          initiated_by?: string
          notes?: string | null
          started_at?: string
          status?: string
          warehouse?: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          count_number?: string
          created_at?: string
          id?: string
          initiated_by?: string
          notes?: string | null
          started_at?: string
          status?: string
          warehouse?: string
        }
        Relationships: [
          {
            foreignKeyName: "cycle_counts_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycle_counts_initiated_by_fkey"
            columns: ["initiated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          assigned_driver: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          completed_at: string | null
          created_at: string
          created_by: string
          customer_id: string
          deleted_at: string | null
          delivery_address_id: string | null
          delivery_notes: string | null
          delivery_number: string
          delivery_window_end: string | null
          delivery_window_start: string | null
          id: string
          is_quick_delivery: boolean | null
          issue_notes: string | null
          issue_type: string | null
          last_edited_at: string | null
          last_edited_by: string | null
          order_id: string
          priority: string | null
          receipt_pdf_url: string | null
          scheduled_date: string
          scheduled_time: string | null
          season: number | null
          signature_url: string | null
          signed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assigned_driver?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by: string
          customer_id: string
          deleted_at?: string | null
          delivery_address_id?: string | null
          delivery_notes?: string | null
          delivery_number: string
          delivery_window_end?: string | null
          delivery_window_start?: string | null
          id?: string
          is_quick_delivery?: boolean | null
          issue_notes?: string | null
          issue_type?: string | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          order_id: string
          priority?: string | null
          receipt_pdf_url?: string | null
          scheduled_date?: string
          scheduled_time?: string | null
          season?: number | null
          signature_url?: string | null
          signed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_driver?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string
          customer_id?: string
          deleted_at?: string | null
          delivery_address_id?: string | null
          delivery_notes?: string | null
          delivery_number?: string
          delivery_window_end?: string | null
          delivery_window_start?: string | null
          id?: string
          is_quick_delivery?: boolean | null
          issue_notes?: string | null
          issue_type?: string | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          order_id?: string
          priority?: string | null
          receipt_pdf_url?: string | null
          scheduled_date?: string
          scheduled_time?: string | null
          season?: number | null
          signature_url?: string | null
          signed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_assigned_driver_fkey"
            columns: ["assigned_driver"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_delivery_address_id_fkey"
            columns: ["delivery_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_items: {
        Row: {
          delivery_id: string
          id: string
          notes: string | null
          order_item_id: string
          product_id: string
          quantity: number
          quantity_delivered: number | null
          tote_number: string | null
          unit_size: string | null
        }
        Insert: {
          delivery_id: string
          id?: string
          notes?: string | null
          order_item_id: string
          product_id: string
          quantity?: number
          quantity_delivered?: number | null
          tote_number?: string | null
          unit_size?: string | null
        }
        Update: {
          delivery_id?: string
          id?: string
          notes?: string | null
          order_item_id?: string
          product_id?: string
          quantity?: number
          quantity_delivered?: number | null
          tote_number?: string | null
          unit_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_items_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_photos: {
        Row: {
          caption: string | null
          delivery_id: string
          file_size: number | null
          id: string
          image_url: string
          sort_order: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          caption?: string | null
          delivery_id: string
          file_size?: number | null
          id?: string
          image_url: string
          sort_order?: number
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          caption?: string | null
          delivery_id?: string
          file_size?: number | null
          id?: string
          image_url?: string
          sort_order?: number
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_photos_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_remainders: {
        Row: {
          created_at: string
          customer_id: string
          escalation_sent_at: string | null
          followup_delivery_id: string | null
          id: string
          notes: string | null
          order_id: string
          order_item_id: string
          original_delivery_id: string
          product_id: string
          quantity_remaining: number
          reminder_sent_at: string | null
          status: string
          unit_size: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          escalation_sent_at?: string | null
          followup_delivery_id?: string | null
          id?: string
          notes?: string | null
          order_id: string
          order_item_id: string
          original_delivery_id: string
          product_id: string
          quantity_remaining: number
          reminder_sent_at?: string | null
          status?: string
          unit_size?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          escalation_sent_at?: string | null
          followup_delivery_id?: string | null
          id?: string
          notes?: string | null
          order_id?: string
          order_item_id?: string
          original_delivery_id?: string
          product_id?: string
          quantity_remaining?: number
          reminder_sent_at?: string | null
          status?: string
          unit_size?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_remainders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_followup_delivery_id_fkey"
            columns: ["followup_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_original_delivery_id_fkey"
            columns: ["original_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_remainders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      email_log: {
        Row: {
          attachment_name: string | null
          created_at: string | null
          created_by: string | null
          customer_id: string | null
          email_type: Database["public"]["Enums"]["email_type"]
          error_message: string | null
          html_body: string | null
          id: string
          idempotency_key: string | null
          recipient_email: string
          resend_message_id: string | null
          status: string
          subject: string
        }
        Insert: {
          attachment_name?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          email_type: Database["public"]["Enums"]["email_type"]
          error_message?: string | null
          html_body?: string | null
          id?: string
          idempotency_key?: string | null
          recipient_email: string
          resend_message_id?: string | null
          status?: string
          subject: string
        }
        Update: {
          attachment_name?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          email_type?: Database["public"]["Enums"]["email_type"]
          error_message?: string | null
          html_body?: string | null
          id?: string
          idempotency_key?: string | null
          recipient_email?: string
          resend_message_id?: string | null
          status?: string
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_log_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      external_identities: {
        Row: {
          contact_id: string | null
          created_at: string
          customer_id: string
          external_id: string
          id: string
          provider: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          customer_id: string
          external_id: string
          id?: string
          provider: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          customer_id?: string
          external_id?: string
          id?: string
          provider?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "external_identities_customer_contact_fk"
            columns: ["customer_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "customer_contacts"
            referencedColumns: ["customer_id", "id"]
          },
          {
            foreignKeyName: "external_identities_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_identities_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      failed_notifications: {
        Row: {
          attempts: number
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error_message: string
          id: string
          max_attempts: number
          notification_type: string
          payload: Json | null
          resolved_at: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_message: string
          id?: string
          max_attempts?: number
          notification_type: string
          payload?: Json | null
          resolved_at?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error_message?: string
          id?: string
          max_attempts?: number
          notification_type?: string
          payload?: Json | null
          resolved_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      field_app_billing_lines: {
        Row: {
          application_service_id: string | null
          billing_set_id: string
          created_at: string
          description: string | null
          id: string
          line_kind: string
          product_id: string | null
          sort_order: number
          source_acres: number | null
          source_line_cents: number | null
          source_quantity: number | null
          source_unit_price_cents: number | null
        }
        Insert: {
          application_service_id?: string | null
          billing_set_id: string
          created_at?: string
          description?: string | null
          id?: string
          line_kind: string
          product_id?: string | null
          sort_order?: number
          source_acres?: number | null
          source_line_cents?: number | null
          source_quantity?: number | null
          source_unit_price_cents?: number | null
        }
        Update: {
          application_service_id?: string | null
          billing_set_id?: string
          created_at?: string
          description?: string | null
          id?: string
          line_kind?: string
          product_id?: string | null
          sort_order?: number
          source_acres?: number | null
          source_line_cents?: number | null
          source_quantity?: number | null
          source_unit_price_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "field_app_billing_lines_application_service_id_fkey"
            columns: ["application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_billing_lines_billing_set_id_fkey"
            columns: ["billing_set_id"]
            isOneToOne: false
            referencedRelation: "field_app_billing_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_billing_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_billing_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      field_app_billing_sets: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          invoice_group_id: string | null
          source_job_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_group_id?: string | null
          source_job_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_group_id?: string | null
          source_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_app_billing_sets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_billing_sets_source_job_id_fkey"
            columns: ["source_job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      field_app_location_shares: {
        Row: {
          acres: number | null
          amount_cents: number
          created_at: string
          customer_id: string
          id: string
          location_id: string
          split_pct: number
        }
        Insert: {
          acres?: number | null
          amount_cents?: number
          created_at?: string
          customer_id: string
          id?: string
          location_id: string
          split_pct: number
        }
        Update: {
          acres?: number | null
          amount_cents?: number
          created_at?: string
          customer_id?: string
          id?: string
          location_id?: string
          split_pct?: number
        }
        Relationships: [
          {
            foreignKeyName: "field_app_location_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_location_shares_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "field_app_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      field_app_locations: {
        Row: {
          applied_acres: number | null
          created_at: string
          crop_type: string | null
          field_id: string
          id: string
          invoice_group_id: string | null
          invoice_id: string | null
          job_id: string | null
          map_number: number | null
          planted_acres: number | null
          sort_order: number | null
          total_acres: number | null
          wind_direction: string | null
        }
        Insert: {
          applied_acres?: number | null
          created_at?: string
          crop_type?: string | null
          field_id: string
          id?: string
          invoice_group_id?: string | null
          invoice_id?: string | null
          job_id?: string | null
          map_number?: number | null
          planted_acres?: number | null
          sort_order?: number | null
          total_acres?: number | null
          wind_direction?: string | null
        }
        Update: {
          applied_acres?: number | null
          created_at?: string
          crop_type?: string | null
          field_id?: string
          id?: string
          invoice_group_id?: string | null
          invoice_id?: string | null
          job_id?: string | null
          map_number?: number | null
          planted_acres?: number | null
          sort_order?: number | null
          total_acres?: number | null
          wind_direction?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_app_locations_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_locations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_app_locations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      field_billing_defaults: {
        Row: {
          created_at: string
          customer_id: string
          field_id: string
          id: string
          is_primary: boolean
          notes: string | null
          price_override_cents: number | null
          pricing_note: string | null
          split_pct: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          field_id: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          price_override_cents?: number | null
          pricing_note?: string | null
          split_pct: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          field_id?: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          price_override_cents?: number | null
          pricing_note?: string | null
          split_pct?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_billing_defaults_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_billing_defaults_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      field_crop_history: {
        Row: {
          created_at: string
          crop_type: string
          field_id: string
          harvest_date: string | null
          id: string
          notes: string | null
          planting_date: string | null
          season: number
          variety: string | null
          yield_per_acre: number | null
          yield_unit: string | null
        }
        Insert: {
          created_at?: string
          crop_type: string
          field_id: string
          harvest_date?: string | null
          id?: string
          notes?: string | null
          planting_date?: string | null
          season: number
          variety?: string | null
          yield_per_acre?: number | null
          yield_unit?: string | null
        }
        Update: {
          created_at?: string
          crop_type?: string
          field_id?: string
          harvest_date?: string | null
          id?: string
          notes?: string | null
          planting_date?: string | null
          season?: number
          variety?: string | null
          yield_per_acre?: number | null
          yield_unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_crop_history_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      field_obstacles: {
        Row: {
          created_at: string
          created_by: string | null
          field_id: string
          id: string
          kind: string
          label: string | null
          point_geojson: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_id: string
          id?: string
          kind: string
          label?: string | null
          point_geojson: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_id?: string
          id?: string
          kind?: string
          label?: string | null
          point_geojson?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_obstacles_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      field_polygons: {
        Row: {
          acres: number | null
          created_at: string | null
          field_id: string
          id: string
          label: string | null
          polygon_geojson: Json
          sort_order: number | null
        }
        Insert: {
          acres?: number | null
          created_at?: string | null
          field_id: string
          id?: string
          label?: string | null
          polygon_geojson: Json
          sort_order?: number | null
        }
        Update: {
          acres?: number | null
          created_at?: string | null
          field_id?: string
          id?: string
          label?: string | null
          polygon_geojson?: Json
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "field_polygons_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      fields: {
        Row: {
          acres_source: string | null
          boundary: unknown
          boundary_geom: unknown
          centroid: unknown
          county: string | null
          created_at: string
          crop_type: string | null
          customer_id: string
          field_name: string
          fsa_farm_number: string | null
          fsa_field_number: string | null
          fsa_tract_number: string | null
          id: string
          irrigation: boolean | null
          is_active: boolean
          legal_description: string | null
          measured_acres: number | null
          notes: string | null
          override_acres: number | null
          parent_field_id: string | null
          soil_type: string | null
          state: string | null
          total_acres: number | null
          updated_at: string
        }
        Insert: {
          acres_source?: string | null
          boundary?: unknown
          boundary_geom?: unknown
          centroid?: unknown
          county?: string | null
          created_at?: string
          crop_type?: string | null
          customer_id: string
          field_name: string
          fsa_farm_number?: string | null
          fsa_field_number?: string | null
          fsa_tract_number?: string | null
          id?: string
          irrigation?: boolean | null
          is_active?: boolean
          legal_description?: string | null
          measured_acres?: number | null
          notes?: string | null
          override_acres?: number | null
          parent_field_id?: string | null
          soil_type?: string | null
          state?: string | null
          total_acres?: number | null
          updated_at?: string
        }
        Update: {
          acres_source?: string | null
          boundary?: unknown
          boundary_geom?: unknown
          centroid?: unknown
          county?: string | null
          created_at?: string
          crop_type?: string | null
          customer_id?: string
          field_name?: string
          fsa_farm_number?: string | null
          fsa_field_number?: string | null
          fsa_tract_number?: string | null
          id?: string
          irrigation?: boolean | null
          is_active?: boolean
          legal_description?: string | null
          measured_acres?: number | null
          notes?: string | null
          override_acres?: number | null
          parent_field_id?: string | null
          soil_type?: string | null
          state?: string | null
          total_acres?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fields_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fields_parent_field_id_fkey"
            columns: ["parent_field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_charges: {
        Row: {
          amount_cents: number
          base_amount_cents: number
          charge_rate: number
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          invoice_id: string | null
          period_end: string
          period_start: string
        }
        Insert: {
          amount_cents: number
          base_amount_cents: number
          charge_rate: number
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          invoice_id?: string | null
          period_end: string
          period_start: string
        }
        Update: {
          amount_cents?: number
          base_amount_cents?: number
          charge_rate?: number
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          invoice_id?: string | null
          period_end?: string
          period_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_charges_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_charges_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_charges_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_audit_log: {
        Row: {
          actor_role: string | null
          actor_user_id: string
          created_at: string
          description: string | null
          entity_id: string
          entity_type: string
          id: string
          new_values: Json | null
          old_values: Json | null
          operation_type: string
          total_impact_cents: number | null
        }
        Insert: {
          actor_role?: string | null
          actor_user_id?: string
          created_at?: string
          description?: string | null
          entity_id: string
          entity_type: string
          id?: string
          new_values?: Json | null
          old_values?: Json | null
          operation_type: string
          total_impact_cents?: number | null
        }
        Update: {
          actor_role?: string | null
          actor_user_id?: string
          created_at?: string
          description?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          new_values?: Json | null
          old_values?: Json | null
          operation_type?: string
          total_impact_cents?: number | null
        }
        Relationships: []
      }
      ground_crew_members: {
        Row: {
          created_at: string
          crew_id: string
          id: string
          is_active: boolean
          name: string
          profile_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          crew_id: string
          id?: string
          is_active?: boolean
          name: string
          profile_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          crew_id?: string
          id?: string
          is_active?: boolean
          name?: string
          profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ground_crew_members_crew_id_fkey"
            columns: ["crew_id"]
            isOneToOne: false
            referencedRelation: "ground_crews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ground_crew_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ground_crews: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ground_crews_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          idempotency_key: string
          operation: string
          request_actor_id: string | null
          request_fingerprint: string | null
          result: Json | null
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          idempotency_key: string
          operation: string
          request_actor_id?: string | null
          request_fingerprint?: string | null
          result?: Json | null
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          idempotency_key?: string
          operation?: string
          request_actor_id?: string | null
          request_fingerprint?: string | null
          result?: Json | null
        }
        Relationships: []
      }
      ingredient_map: {
        Row: {
          branded_ingredient: string
          fallback_branded_product: string | null
          generic_has_bulk: boolean
          generic_product_id: string | null
          id: string
          notes: string | null
        }
        Insert: {
          branded_ingredient?: string
          fallback_branded_product?: string | null
          generic_has_bulk?: boolean
          generic_product_id?: string | null
          id?: string
          notes?: string | null
        }
        Update: {
          branded_ingredient?: string
          fallback_branded_product?: string | null
          generic_has_bulk?: boolean
          generic_product_id?: string | null
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_map_generic_product_id_fkey"
            columns: ["generic_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_map_generic_product_id_fkey"
            columns: ["generic_product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      integrity_alerts: {
        Row: {
          alert_type: string
          details: Json
          detected_at: string
          entity_id: string
          entity_table: string
          id: string
          resolved_at: string | null
        }
        Insert: {
          alert_type: string
          details?: Json
          detected_at?: string
          entity_id: string
          entity_table: string
          id?: string
          resolved_at?: string | null
        }
        Update: {
          alert_type?: string
          details?: Json
          detected_at?: string
          entity_id?: string
          entity_table?: string
          id?: string
          resolved_at?: string | null
        }
        Relationships: []
      }
      integrity_negative_baseline: {
        Row: {
          baselined_at: string
          product_id: string
          quantity_at_baseline: number
        }
        Insert: {
          baselined_at?: string
          product_id: string
          quantity_at_baseline: number
        }
        Update: {
          baselined_at?: string
          product_id?: string
          quantity_at_baseline?: number
        }
        Relationships: [
          {
            foreignKeyName: "integrity_negative_baseline_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrity_negative_baseline_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      interaction_transcripts: {
        Row: {
          ai_disclosed_at: string | null
          ai_summary: string | null
          created_at: string
          disclosure_version: string | null
          extraction: Json | null
          id: string
          interaction_id: string
          recording_consent_at: string | null
          recording_consent_method: string | null
          recording_consent_status: string | null
          recording_disclosed_at: string | null
          recording_path: string | null
          retention_expires_at: string | null
          transcript: string | null
          updated_at: string
        }
        Insert: {
          ai_disclosed_at?: string | null
          ai_summary?: string | null
          created_at?: string
          disclosure_version?: string | null
          extraction?: Json | null
          id?: string
          interaction_id: string
          recording_consent_at?: string | null
          recording_consent_method?: string | null
          recording_consent_status?: string | null
          recording_disclosed_at?: string | null
          recording_path?: string | null
          retention_expires_at?: string | null
          transcript?: string | null
          updated_at?: string
        }
        Update: {
          ai_disclosed_at?: string | null
          ai_summary?: string | null
          created_at?: string
          disclosure_version?: string | null
          extraction?: Json | null
          id?: string
          interaction_id?: string
          recording_consent_at?: string | null
          recording_consent_method?: string | null
          recording_consent_status?: string | null
          recording_disclosed_at?: string | null
          recording_path?: string | null
          retention_expires_at?: string | null
          transcript?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "interaction_transcripts_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: true
            referencedRelation: "customer_interactions"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          id: string
          last_counted_at: string | null
          location: string
          manufactured_at_delivery: boolean
          min_stock_level: number
          product_id: string
          quantity_available: number
          quantity_on_order: number
          quantity_prebooked: number
          reorder_point: number
          unit_size: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          last_counted_at?: string | null
          location?: string
          manufactured_at_delivery?: boolean
          min_stock_level?: number
          product_id: string
          quantity_available?: number
          quantity_on_order?: number
          quantity_prebooked?: number
          reorder_point?: number
          unit_size?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          last_counted_at?: string | null
          location?: string
          manufactured_at_delivery?: boolean
          min_stock_level?: number
          product_id?: string
          quantity_available?: number
          quantity_on_order?: number
          quantity_prebooked?: number
          reorder_point?: number
          unit_size?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_holds: {
        Row: {
          created_at: string
          created_by: string
          customer_id: string | null
          expires_at: string | null
          hold_type: string
          id: string
          is_active: boolean
          notes: string | null
          product_id: string
          quantity: number
          source_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          customer_id?: string | null
          expires_at?: string | null
          hold_type?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          product_id: string
          quantity?: number
          source_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          customer_id?: string | null
          expires_at?: string | null
          hold_type?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          product_id?: string
          quantity?: number
          source_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_holds_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_holds_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_holds_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_holds_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_transactions: {
        Row: {
          created_at: string
          delivery_id: string | null
          from_location: string | null
          id: string
          job_id: string | null
          notes: string | null
          order_id: string | null
          performed_by: string
          product_id: string
          purchase_order_id: string | null
          quantity: number
          requires_review: boolean
          to_location: string | null
          transaction_type: string
        }
        Insert: {
          created_at?: string
          delivery_id?: string | null
          from_location?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          order_id?: string | null
          performed_by: string
          product_id: string
          purchase_order_id?: string | null
          quantity?: number
          requires_review?: boolean
          to_location?: string | null
          transaction_type: string
        }
        Update: {
          created_at?: string
          delivery_id?: string | null
          from_location?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          order_id?: string | null
          performed_by?: string
          product_id?: string
          purchase_order_id?: string | null
          quantity?: number
          requires_review?: boolean
          to_location?: string | null
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_transactions_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_delivery_recovery_capabilities: {
        Row: {
          actor_id: string
          created_at: string
          delivery_id: string
          purpose: string
          transaction_id: number
        }
        Insert: {
          actor_id: string
          created_at?: string
          delivery_id: string
          purpose: string
          transaction_id: number
        }
        Update: {
          actor_id?: string
          created_at?: string
          delivery_id?: string
          purpose?: string
          transaction_id?: number
        }
        Relationships: []
      }
      invoice_items: {
        Row: {
          acres: number | null
          billing_line_id: string | null
          cost_cents: number
          created_at: string
          description: string
          epa_registration: string | null
          extended_cents: number
          gl_lb_unit: string | null
          id: string
          invoice_id: string
          is_application_fee: boolean | null
          notes: string | null
          order_item_id: string | null
          price_source: string | null
          product_form: string | null
          product_id: string | null
          quantity: number
          quoted_price_cents: number | null
          rate_per_acre: number | null
          rate_unit: string | null
          sort_order: number
          total_applied: number | null
          total_applied_gl_lb: number | null
          total_applied_unit: string | null
          tote_number: string | null
          unit_price_cents: number
          unit_size: string | null
          updated_at: string
          vendor: string | null
          warehouse: string | null
        }
        Insert: {
          acres?: number | null
          billing_line_id?: string | null
          cost_cents?: number
          created_at?: string
          description?: string
          epa_registration?: string | null
          extended_cents?: number
          gl_lb_unit?: string | null
          id?: string
          invoice_id: string
          is_application_fee?: boolean | null
          notes?: string | null
          order_item_id?: string | null
          price_source?: string | null
          product_form?: string | null
          product_id?: string | null
          quantity?: number
          quoted_price_cents?: number | null
          rate_per_acre?: number | null
          rate_unit?: string | null
          sort_order?: number
          total_applied?: number | null
          total_applied_gl_lb?: number | null
          total_applied_unit?: string | null
          tote_number?: string | null
          unit_price_cents?: number
          unit_size?: string | null
          updated_at?: string
          vendor?: string | null
          warehouse?: string | null
        }
        Update: {
          acres?: number | null
          billing_line_id?: string | null
          cost_cents?: number
          created_at?: string
          description?: string
          epa_registration?: string | null
          extended_cents?: number
          gl_lb_unit?: string | null
          id?: string
          invoice_id?: string
          is_application_fee?: boolean | null
          notes?: string | null
          order_item_id?: string | null
          price_source?: string | null
          product_form?: string | null
          product_id?: string | null
          quantity?: number
          quoted_price_cents?: number | null
          rate_per_acre?: number | null
          rate_unit?: string | null
          sort_order?: number
          total_applied?: number | null
          total_applied_gl_lb?: number | null
          total_applied_unit?: string | null
          tote_number?: string | null
          unit_price_cents?: number
          unit_size?: string | null
          updated_at?: string
          vendor?: string | null
          warehouse?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_billing_line_id_fkey"
            columns: ["billing_line_id"]
            isOneToOne: false
            referencedRelation: "field_app_billing_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_allocations: {
        Row: {
          allocation_set_id: string
          amount_cents: number
          bill_to_customer_id: string
          created_at: string
          id: string
          invoice_id: string | null
          invoice_item_id: string | null
          split_invoice_id: string | null
          split_percentage: number
        }
        Insert: {
          allocation_set_id: string
          amount_cents: number
          bill_to_customer_id: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          invoice_item_id?: string | null
          split_invoice_id?: string | null
          split_percentage: number
        }
        Update: {
          allocation_set_id?: string
          amount_cents?: number
          bill_to_customer_id?: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          invoice_item_id?: string | null
          split_invoice_id?: string | null
          split_percentage?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_allocations_allocation_set_id_fkey"
            columns: ["allocation_set_id"]
            isOneToOne: false
            referencedRelation: "allocation_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_allocations_bill_to_customer_id_fkey"
            columns: ["bill_to_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_allocations_invoice_item_id_fkey"
            columns: ["invoice_item_id"]
            isOneToOne: false
            referencedRelation: "invoice_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_allocations_split_invoice_id_fkey"
            columns: ["split_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_share_snapshots: {
        Row: {
          allocated_acres: number | null
          allocated_quantity: number | null
          amount_cents: number
          application_service_id: string | null
          base_price_source: string | null
          base_unit_price_cents: number | null
          billing_line_id: string | null
          calculation_hash: string | null
          created_at: string
          customer_id: string
          id: string
          invoice_id: string
          line_description: string | null
          line_kind: string | null
          posted_at: string
          price_mode: string | null
          price_override_reason: string | null
          product_id: string | null
          snapshot_reason: string
          split_micro_pct: number
          split_mode: string | null
          split_override_reason: string | null
          unit_price_cents: number
          vector_hash: string | null
        }
        Insert: {
          allocated_acres?: number | null
          allocated_quantity?: number | null
          amount_cents: number
          application_service_id?: string | null
          base_price_source?: string | null
          base_unit_price_cents?: number | null
          billing_line_id?: string | null
          calculation_hash?: string | null
          created_at?: string
          customer_id: string
          id?: string
          invoice_id: string
          line_description?: string | null
          line_kind?: string | null
          posted_at?: string
          price_mode?: string | null
          price_override_reason?: string | null
          product_id?: string | null
          snapshot_reason?: string
          split_micro_pct: number
          split_mode?: string | null
          split_override_reason?: string | null
          unit_price_cents: number
          vector_hash?: string | null
        }
        Update: {
          allocated_acres?: number | null
          allocated_quantity?: number | null
          amount_cents?: number
          application_service_id?: string | null
          base_price_source?: string | null
          base_unit_price_cents?: number | null
          billing_line_id?: string | null
          calculation_hash?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          invoice_id?: string
          line_description?: string | null
          line_kind?: string | null
          posted_at?: string
          price_mode?: string | null
          price_override_reason?: string | null
          product_id?: string | null
          snapshot_reason?: string
          split_micro_pct?: number
          split_mode?: string | null
          split_override_reason?: string | null
          unit_price_cents?: number
          vector_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_share_snapshots_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_share_snapshots_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_shares: {
        Row: {
          allocated_acres: number | null
          allocated_quantity: number | null
          amount_cents: number
          base_price_source: string
          base_unit_price_cents: number
          billing_line_id: string
          calculation_hash: string
          created_at: string
          created_by: string
          customer_id: string
          id: string
          invoice_item_id: string
          price_mode: string
          price_override_reason: string | null
          split_micro_pct: number
          split_mode: string
          split_override_reason: string | null
          unit_price_cents: number
          vector_hash: string
        }
        Insert: {
          allocated_acres?: number | null
          allocated_quantity?: number | null
          amount_cents: number
          base_price_source: string
          base_unit_price_cents: number
          billing_line_id: string
          calculation_hash: string
          created_at?: string
          created_by: string
          customer_id: string
          id?: string
          invoice_item_id: string
          price_mode?: string
          price_override_reason?: string | null
          split_micro_pct: number
          split_mode: string
          split_override_reason?: string | null
          unit_price_cents: number
          vector_hash: string
        }
        Update: {
          allocated_acres?: number | null
          allocated_quantity?: number | null
          amount_cents?: number
          base_price_source?: string
          base_unit_price_cents?: number
          billing_line_id?: string
          calculation_hash?: string
          created_at?: string
          created_by?: string
          customer_id?: string
          id?: string
          invoice_item_id?: string
          price_mode?: string
          price_override_reason?: string | null
          split_micro_pct?: number
          split_mode?: string
          split_override_reason?: string | null
          unit_price_cents?: number
          vector_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_shares_billing_line_id_fkey"
            columns: ["billing_line_id"]
            isOneToOne: false
            referencedRelation: "field_app_billing_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_shares_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_shares_invoice_item_id_fkey"
            columns: ["invoice_item_id"]
            isOneToOne: true
            referencedRelation: "invoice_items"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_shares: {
        Row: {
          acres: number | null
          amount_cents: number
          created_at: string
          customer_id: string
          customer_name: string
          id: string
          invoice_id: string
          is_primary: boolean | null
          price_per_acre_cents: number | null
          pricing_note: string | null
          sort_order: number | null
          split_percentage: number
        }
        Insert: {
          acres?: number | null
          amount_cents: number
          created_at?: string
          customer_id: string
          customer_name: string
          id?: string
          invoice_id: string
          is_primary?: boolean | null
          price_per_acre_cents?: number | null
          pricing_note?: string | null
          sort_order?: number | null
          split_percentage: number
        }
        Update: {
          acres?: number | null
          amount_cents?: number
          created_at?: string
          customer_id?: string
          customer_name?: string
          id?: string
          invoice_id?: string
          is_primary?: boolean | null
          price_per_acre_cents?: number | null
          pricing_note?: string | null
          sort_order?: number | null
          split_percentage?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_shares_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          application_date: string | null
          application_service_id: string | null
          applicator_name: string | null
          balance_cents: number | null
          blend_ticket_id: string | null
          created_at: string
          created_by: string
          credit_applied_cents: number
          crop_type: string | null
          customer_id: string
          deleted_at: string | null
          delivery_id: string | null
          diluent_rate_gpa: number | null
          discount_date: string | null
          discount_earned_cents: number
          due_date: string | null
          due_date_source: string
          end_humidity_pct: number | null
          end_temp_f: number | null
          end_weather_source: string | null
          end_weather_time: string | null
          end_wind_direction: string | null
          end_wind_mph: number | null
          field_app_billing_set_id: string | null
          field_names: string[] | null
          footer_notes: string | null
          header_notes: string | null
          id: string
          internal_notes: string | null
          invoice_date: string
          invoice_group_id: string | null
          invoice_number: string
          invoice_type: string
          is_quick_delivery: boolean | null
          job_id: string | null
          order_id: string | null
          paid_amount_cents: number
          parent_invoice_id: string | null
          payment_terms: string | null
          posted_at: string | null
          posted_by: string | null
          prepay_applied_cents: number
          pricing_pending: boolean
          purchase_order_ref: string | null
          salesman_id: string | null
          season: number
          send_disposition: string
          start_humidity_pct: number | null
          start_temp_f: number | null
          start_weather_source: string | null
          start_weather_time: string | null
          start_wind_direction: string | null
          start_wind_mph: number | null
          status: string
          temperature_text: string | null
          total_acres: number | null
          total_amount_cents: number
          total_cost_cents: number | null
          updated_at: string
          vehicle_name: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
          weather_manual_override: boolean | null
          wind_direction: string | null
          write_off_cents: number
        }
        Insert: {
          application_date?: string | null
          application_service_id?: string | null
          applicator_name?: string | null
          balance_cents?: number | null
          blend_ticket_id?: string | null
          created_at?: string
          created_by?: string
          credit_applied_cents?: number
          crop_type?: string | null
          customer_id: string
          deleted_at?: string | null
          delivery_id?: string | null
          diluent_rate_gpa?: number | null
          discount_date?: string | null
          discount_earned_cents?: number
          due_date?: string | null
          due_date_source?: string
          end_humidity_pct?: number | null
          end_temp_f?: number | null
          end_weather_source?: string | null
          end_weather_time?: string | null
          end_wind_direction?: string | null
          end_wind_mph?: number | null
          field_app_billing_set_id?: string | null
          field_names?: string[] | null
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          internal_notes?: string | null
          invoice_date?: string
          invoice_group_id?: string | null
          invoice_number?: string
          invoice_type?: string
          is_quick_delivery?: boolean | null
          job_id?: string | null
          order_id?: string | null
          paid_amount_cents?: number
          parent_invoice_id?: string | null
          payment_terms?: string | null
          posted_at?: string | null
          posted_by?: string | null
          prepay_applied_cents?: number
          pricing_pending?: boolean
          purchase_order_ref?: string | null
          salesman_id?: string | null
          season?: number
          send_disposition?: string
          start_humidity_pct?: number | null
          start_temp_f?: number | null
          start_weather_source?: string | null
          start_weather_time?: string | null
          start_wind_direction?: string | null
          start_wind_mph?: number | null
          status?: string
          temperature_text?: string | null
          total_acres?: number | null
          total_amount_cents?: number
          total_cost_cents?: number | null
          updated_at?: string
          vehicle_name?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          weather_manual_override?: boolean | null
          wind_direction?: string | null
          write_off_cents?: number
        }
        Update: {
          application_date?: string | null
          application_service_id?: string | null
          applicator_name?: string | null
          balance_cents?: number | null
          blend_ticket_id?: string | null
          created_at?: string
          created_by?: string
          credit_applied_cents?: number
          crop_type?: string | null
          customer_id?: string
          deleted_at?: string | null
          delivery_id?: string | null
          diluent_rate_gpa?: number | null
          discount_date?: string | null
          discount_earned_cents?: number
          due_date?: string | null
          due_date_source?: string
          end_humidity_pct?: number | null
          end_temp_f?: number | null
          end_weather_source?: string | null
          end_weather_time?: string | null
          end_wind_direction?: string | null
          end_wind_mph?: number | null
          field_app_billing_set_id?: string | null
          field_names?: string[] | null
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          internal_notes?: string | null
          invoice_date?: string
          invoice_group_id?: string | null
          invoice_number?: string
          invoice_type?: string
          is_quick_delivery?: boolean | null
          job_id?: string | null
          order_id?: string | null
          paid_amount_cents?: number
          parent_invoice_id?: string | null
          payment_terms?: string | null
          posted_at?: string | null
          posted_by?: string | null
          prepay_applied_cents?: number
          pricing_pending?: boolean
          purchase_order_ref?: string | null
          salesman_id?: string | null
          season?: number
          send_disposition?: string
          start_humidity_pct?: number | null
          start_temp_f?: number | null
          start_weather_source?: string | null
          start_weather_time?: string | null
          start_wind_direction?: string | null
          start_wind_mph?: number | null
          status?: string
          temperature_text?: string | null
          total_acres?: number | null
          total_amount_cents?: number
          total_cost_cents?: number | null
          updated_at?: string
          vehicle_name?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          weather_manual_override?: boolean | null
          wind_direction?: string | null
          write_off_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_application_service_id_fkey"
            columns: ["application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_field_app_billing_set_id_fkey"
            columns: ["field_app_billing_set_id"]
            isOneToOne: false
            referencedRelation: "field_app_billing_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_parent_invoice_id_fkey"
            columns: ["parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_salesman_id_fkey"
            columns: ["salesman_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_applied_info: {
        Row: {
          actual_end_time: string | null
          actual_gallons_applied: number | null
          actual_start_time: string | null
          created_at: string
          humidity: number | null
          id: string
          job_id: string
          notes: string | null
          temperature: number | null
          updated_at: string
          wind_direction: string | null
          wind_speed: number | null
        }
        Insert: {
          actual_end_time?: string | null
          actual_gallons_applied?: number | null
          actual_start_time?: string | null
          created_at?: string
          humidity?: number | null
          id?: string
          job_id: string
          notes?: string | null
          temperature?: number | null
          updated_at?: string
          wind_direction?: string | null
          wind_speed?: number | null
        }
        Update: {
          actual_end_time?: string | null
          actual_gallons_applied?: number | null
          actual_start_time?: string | null
          created_at?: string
          humidity?: number | null
          id?: string
          job_id?: string
          notes?: string | null
          temperature?: number | null
          updated_at?: string
          wind_direction?: string | null
          wind_speed?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_applied_info_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_applied_record_crew: {
        Row: {
          application_record_id: string
          created_at: string
          crew_id_snapshot: string | null
          crew_name_snapshot: string | null
          id: string
          member_id: string | null
          member_name_snapshot: string
        }
        Insert: {
          application_record_id: string
          created_at?: string
          crew_id_snapshot?: string | null
          crew_name_snapshot?: string | null
          id?: string
          member_id?: string | null
          member_name_snapshot: string
        }
        Update: {
          application_record_id?: string
          created_at?: string
          crew_id_snapshot?: string | null
          crew_name_snapshot?: string | null
          id?: string
          member_id?: string | null
          member_name_snapshot?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_applied_record_crew_application_record_id_fkey"
            columns: ["application_record_id"]
            isOneToOne: false
            referencedRelation: "job_applied_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applied_record_crew_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "ground_crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      job_applied_record_fields: {
        Row: {
          application_record_id: string
          applied_acres: number
          created_at: string
          field_id: string
          id: string
          updated_at: string
        }
        Insert: {
          application_record_id: string
          applied_acres?: number
          created_at?: string
          field_id: string
          id?: string
          updated_at?: string
        }
        Update: {
          application_record_id?: string
          applied_acres?: number
          created_at?: string
          field_id?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_applied_record_fields_application_record_id_fkey"
            columns: ["application_record_id"]
            isOneToOne: false
            referencedRelation: "job_applied_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applied_record_fields_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
        ]
      }
      job_applied_records: {
        Row: {
          application_date: string
          applicator_id: string | null
          applied_acres: number | null
          beginning_tach: number | null
          created_at: string
          created_by: string | null
          end_humidity_pct: number | null
          end_tach: number | null
          end_temp_f: number | null
          end_weather_source: string | null
          end_weather_time: string | null
          end_wind_direction: string | null
          end_wind_mph: number | null
          id: string
          idempotency_key: string | null
          idempotency_request_hash: string | null
          job_id: string
          net_tach: number | null
          notes: string | null
          start_humidity_pct: number | null
          start_temp_f: number | null
          start_weather_source: string | null
          start_weather_time: string | null
          start_wind_direction: string | null
          start_wind_mph: number | null
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          application_date: string
          applicator_id?: string | null
          applied_acres?: number | null
          beginning_tach?: number | null
          created_at?: string
          created_by?: string | null
          end_humidity_pct?: number | null
          end_tach?: number | null
          end_temp_f?: number | null
          end_weather_source?: string | null
          end_weather_time?: string | null
          end_wind_direction?: string | null
          end_wind_mph?: number | null
          id?: string
          idempotency_key?: string | null
          idempotency_request_hash?: string | null
          job_id: string
          net_tach?: number | null
          notes?: string | null
          start_humidity_pct?: number | null
          start_temp_f?: number | null
          start_weather_source?: string | null
          start_weather_time?: string | null
          start_wind_direction?: string | null
          start_wind_mph?: number | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          application_date?: string
          applicator_id?: string | null
          applied_acres?: number | null
          beginning_tach?: number | null
          created_at?: string
          created_by?: string | null
          end_humidity_pct?: number | null
          end_tach?: number | null
          end_temp_f?: number | null
          end_weather_source?: string | null
          end_weather_time?: string | null
          end_wind_direction?: string | null
          end_wind_mph?: number | null
          id?: string
          idempotency_key?: string | null
          idempotency_request_hash?: string | null
          job_id?: string
          net_tach?: number | null
          notes?: string | null
          start_humidity_pct?: number | null
          start_temp_f?: number | null
          start_weather_source?: string | null
          start_weather_time?: string | null
          start_wind_direction?: string | null
          start_wind_mph?: number | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_applied_records_applicator_id_fkey"
            columns: ["applicator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applied_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applied_records_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applied_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_attachments: {
        Row: {
          content_type: string | null
          file_name: string
          file_size: number | null
          id: string
          job_id: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          content_type?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          job_id: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          content_type?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          job_id?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_attachments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_batches: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_chemicals: {
        Row: {
          cost_per_unit_cents: number | null
          customer_supplied: boolean
          diluent_rate: number | null
          driver: string | null
          id: string
          job_id: string
          phi_days: number | null
          price_per_unit_cents: number | null
          product_id: string
          quantity: number
          rate_per_acre: number | null
          rate_unit: string | null
          rei_hours: number | null
          sort_order: number | null
          unit: string | null
          vendor: string | null
          warehouse: string | null
        }
        Insert: {
          cost_per_unit_cents?: number | null
          customer_supplied?: boolean
          diluent_rate?: number | null
          driver?: string | null
          id?: string
          job_id: string
          phi_days?: number | null
          price_per_unit_cents?: number | null
          product_id: string
          quantity?: number
          rate_per_acre?: number | null
          rate_unit?: string | null
          rei_hours?: number | null
          sort_order?: number | null
          unit?: string | null
          vendor?: string | null
          warehouse?: string | null
        }
        Update: {
          cost_per_unit_cents?: number | null
          customer_supplied?: boolean
          diluent_rate?: number | null
          driver?: string | null
          id?: string
          job_id?: string
          phi_days?: number | null
          price_per_unit_cents?: number | null
          product_id?: string
          quantity?: number
          rate_per_acre?: number | null
          rate_unit?: string | null
          rei_hours?: number | null
          sort_order?: number | null
          unit?: string | null
          vendor?: string | null
          warehouse?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_chemicals_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_chemicals_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_chemicals_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      job_dispatch_preservation: {
        Row: {
          applicator_id: string | null
          crew_id: string | null
          dispatched_at: string | null
          dispatched_by: string | null
          field_id: string
          job_id: string
          preserved_at: string
        }
        Insert: {
          applicator_id?: string | null
          crew_id?: string | null
          dispatched_at?: string | null
          dispatched_by?: string | null
          field_id: string
          job_id: string
          preserved_at?: string
        }
        Update: {
          applicator_id?: string | null
          crew_id?: string | null
          dispatched_at?: string | null
          dispatched_by?: string | null
          field_id?: string
          job_id?: string
          preserved_at?: string
        }
        Relationships: []
      }
      job_field_shares: {
        Row: {
          created_at: string
          customer_id: string
          field_id: string
          id: string
          is_primary: boolean
          job_id: string
          split_pct: number
        }
        Insert: {
          created_at?: string
          customer_id: string
          field_id: string
          id?: string
          is_primary?: boolean
          job_id: string
          split_pct: number
        }
        Update: {
          created_at?: string
          customer_id?: string
          field_id?: string
          id?: string
          is_primary?: boolean
          job_id?: string
          split_pct?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_field_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_field_shares_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_field_shares_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_fields: {
        Row: {
          acres_to_treat: number | null
          crop: string | null
          field_id: string
          id: string
          job_id: string
          pests: string | null
          planted_acres: number | null
          sort_order: number | null
          strip: string | null
        }
        Insert: {
          acres_to_treat?: number | null
          crop?: string | null
          field_id: string
          id?: string
          job_id: string
          pests?: string | null
          planted_acres?: number | null
          sort_order?: number | null
          strip?: string | null
        }
        Update: {
          acres_to_treat?: number | null
          crop?: string | null
          field_id?: string
          id?: string
          job_id?: string
          pests?: string | null
          planted_acres?: number | null
          sort_order?: number | null
          strip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_fields_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_fields_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_loader_worksheets: {
        Row: {
          capacity_gal: number
          carrier_rate_gpa: number | null
          comment: string | null
          created_at: string
          created_by: string | null
          id: string
          is_selected: boolean
          job_id: string
          load_balance_mode: string
          loads_done: Json
          per_load_acres: Json | null
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          capacity_gal: number
          carrier_rate_gpa?: number | null
          comment?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_selected?: boolean
          job_id: string
          load_balance_mode?: string
          loads_done?: Json
          per_load_acres?: Json | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          capacity_gal?: number
          carrier_rate_gpa?: number | null
          comment?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_selected?: boolean
          job_id?: string
          load_balance_mode?: string
          loads_done?: Json
          per_load_acres?: Json | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_loader_worksheets_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_loader_worksheets_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_location_dispatches: {
        Row: {
          applicator_id: string | null
          created_at: string
          crew_id: string | null
          dispatch_status: string
          dispatched_at: string
          dispatched_by: string | null
          id: string
          job_field_id: string
          job_id: string
          updated_at: string
        }
        Insert: {
          applicator_id?: string | null
          created_at?: string
          crew_id?: string | null
          dispatch_status?: string
          dispatched_at?: string
          dispatched_by?: string | null
          id?: string
          job_field_id: string
          job_id: string
          updated_at?: string
        }
        Update: {
          applicator_id?: string | null
          created_at?: string
          crew_id?: string | null
          dispatch_status?: string
          dispatched_at?: string
          dispatched_by?: string | null
          id?: string
          job_field_id?: string
          job_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_location_dispatches_applicator_id_fkey"
            columns: ["applicator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_location_dispatches_crew_id_fkey"
            columns: ["crew_id"]
            isOneToOne: false
            referencedRelation: "ground_crews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_location_dispatches_dispatched_by_fkey"
            columns: ["dispatched_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_location_dispatches_job_field_id_fkey"
            columns: ["job_field_id"]
            isOneToOne: true
            referencedRelation: "job_fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_location_dispatches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_notifications: {
        Row: {
          channel: string
          created_at: string
          customer_id: string | null
          id: string
          idempotency_key: string | null
          job_id: string
          message: string | null
          notification_type: string
          recipient_email: string | null
          sent_at: string | null
          sent_by: string | null
          status: string
          subject: string | null
        }
        Insert: {
          channel?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          idempotency_key?: string | null
          job_id: string
          message?: string | null
          notification_type: string
          recipient_email?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          idempotency_key?: string | null
          job_id?: string
          message?: string | null
          notification_type?: string
          recipient_email?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_notifications_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notifications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notifications_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_product_draws: {
        Row: {
          created_at: string
          id: string
          job_id: string
          product_id: string
          quantity_drawn: number
          quote_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_id: string
          product_id: string
          quantity_drawn?: number
          quote_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          job_id?: string
          product_id?: string
          quantity_drawn?: number
          quote_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_product_draws_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_product_draws_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_product_draws_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_product_draws_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_tag_assignments: {
        Row: {
          created_at: string
          job_id: string
          tag_id: string
        }
        Insert: {
          created_at?: string
          job_id: string
          tag_id: string
        }
        Update: {
          created_at?: string
          job_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_tag_assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_tag_assignments_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "job_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      job_tags: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_tags_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          additional_info: string | null
          application_service_id: string | null
          applicator_id: string | null
          applied_acres: number
          batch_id: string | null
          batch_ref: string | null
          call_date: string | null
          carrier_rate_gpa: number | null
          commission_split: Json | null
          consultant_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          date_expires: string | null
          date_proposed: string | null
          deleted_at: string | null
          estimated_hours: number | null
          ground_crew_id: string | null
          id: string
          internal_memo: string | null
          invoice_id: string | null
          job_date: string
          job_number: string
          last_printed_by: string | null
          loader_comment: string | null
          loader_tank_capacity: number | null
          notes: string | null
          printed_at: string | null
          priority: string
          quote_id: string | null
          quote_section_id: string | null
          recipe_id: string | null
          remaining_acres: number | null
          schedule_date: string | null
          scheduled_time: string | null
          season: number | null
          status: string
          tags: string[] | null
          time_proposed: string | null
          total_acres: number | null
          total_cost_cents: number | null
          total_price_cents: number | null
          updated_at: string
          updated_by: string | null
          vehicle_id: string | null
        }
        Insert: {
          additional_info?: string | null
          application_service_id?: string | null
          applicator_id?: string | null
          applied_acres?: number
          batch_id?: string | null
          batch_ref?: string | null
          call_date?: string | null
          carrier_rate_gpa?: number | null
          commission_split?: Json | null
          consultant_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          date_expires?: string | null
          date_proposed?: string | null
          deleted_at?: string | null
          estimated_hours?: number | null
          ground_crew_id?: string | null
          id?: string
          internal_memo?: string | null
          invoice_id?: string | null
          job_date: string
          job_number: string
          last_printed_by?: string | null
          loader_comment?: string | null
          loader_tank_capacity?: number | null
          notes?: string | null
          printed_at?: string | null
          priority?: string
          quote_id?: string | null
          quote_section_id?: string | null
          recipe_id?: string | null
          remaining_acres?: number | null
          schedule_date?: string | null
          scheduled_time?: string | null
          season?: number | null
          status?: string
          tags?: string[] | null
          time_proposed?: string | null
          total_acres?: number | null
          total_cost_cents?: number | null
          total_price_cents?: number | null
          updated_at?: string
          updated_by?: string | null
          vehicle_id?: string | null
        }
        Update: {
          additional_info?: string | null
          application_service_id?: string | null
          applicator_id?: string | null
          applied_acres?: number
          batch_id?: string | null
          batch_ref?: string | null
          call_date?: string | null
          carrier_rate_gpa?: number | null
          commission_split?: Json | null
          consultant_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          date_expires?: string | null
          date_proposed?: string | null
          deleted_at?: string | null
          estimated_hours?: number | null
          ground_crew_id?: string | null
          id?: string
          internal_memo?: string | null
          invoice_id?: string | null
          job_date?: string
          job_number?: string
          last_printed_by?: string | null
          loader_comment?: string | null
          loader_tank_capacity?: number | null
          notes?: string | null
          printed_at?: string | null
          priority?: string
          quote_id?: string | null
          quote_section_id?: string | null
          recipe_id?: string | null
          remaining_acres?: number | null
          schedule_date?: string | null
          scheduled_time?: string | null
          season?: number | null
          status?: string
          tags?: string[] | null
          time_proposed?: string | null
          total_acres?: number | null
          total_cost_cents?: number | null
          total_price_cents?: number | null
          updated_at?: string
          updated_by?: string | null
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_application_service_id_fkey"
            columns: ["application_service_id"]
            isOneToOne: false
            referencedRelation: "application_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_applicator_id_fkey"
            columns: ["applicator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_batch_ref_fkey"
            columns: ["batch_ref"]
            isOneToOne: false
            referencedRelation: "job_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_consultant_id_fkey"
            columns: ["consultant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_ground_crew_id_fkey"
            columns: ["ground_crew_id"]
            isOneToOne: false
            referencedRelation: "ground_crews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_last_printed_by_fkey"
            columns: ["last_printed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_quote_section_id_fkey"
            columns: ["quote_section_id"]
            isOneToOne: false
            referencedRelation: "quote_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "blend_recipes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      legacy_vendor_resolution: {
        Row: {
          confidence: number
          created_at: string
          created_by: string | null
          id: string
          normalized_text: string | null
          original_text: string
          review_note: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_table: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          created_by?: string | null
          id?: string
          normalized_text?: string | null
          original_text: string
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_table: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          created_by?: string | null
          id?: string
          normalized_text?: string | null
          original_text?: string
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_table?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "legacy_vendor_resolution_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_vendor_resolution_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_vendor_resolution_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      note_activity_log: {
        Row: {
          action_type: string
          changes: Json | null
          created_at: string | null
          id: string
          note_id: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          changes?: Json | null
          created_at?: string | null
          id?: string
          note_id?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          changes?: Json | null
          created_at?: string | null
          id?: string
          note_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_activity_log_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "team_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_activity_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      note_tags: {
        Row: {
          color: string
          created_at: string | null
          created_by: string
          id: string
          name: string
        }
        Insert: {
          color?: string
          created_at?: string | null
          created_by: string
          id?: string
          name: string
        }
        Update: {
          color?: string
          created_at?: string | null
          created_by?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_tags_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          message: string
          notification_type: string
          related_entity_id: string | null
          related_entity_type: string | null
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          message?: string
          notification_type?: string
          related_entity_id?: string | null
          related_entity_type?: string | null
          title?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          message?: string
          notification_type?: string
          related_entity_id?: string | null
          related_entity_type?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ocr_processing_queue: {
        Row: {
          blend_ticket_id: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          lease_heartbeat_at: string | null
          lease_token: string | null
          max_retries: number
          priority: number
          retry_count: number
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          blend_ticket_id: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          lease_heartbeat_at?: string | null
          lease_token?: string | null
          max_retries?: number
          priority?: number
          retry_count?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          blend_ticket_id?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          lease_heartbeat_at?: string | null
          lease_token?: string | null
          max_retries?: number
          priority?: number
          retry_count?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ocr_processing_queue_blend_ticket_id_fkey"
            columns: ["blend_ticket_id"]
            isOneToOne: false
            referencedRelation: "blend_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      offline_action_receipts: {
        Row: {
          actor_id: string
          attempt_count: number
          client_action_id: string
          client_created_at: string
          created_at: string
          entity_id: string
          entity_snapshot_at: string | null
          failure_code: string | null
          failure_summary: string | null
          idempotency_key: string
          last_attempt_at: string | null
          needs_review_at: string | null
          operation: string
          received_at: string
          request_payload: Json
          resolved_at: string | null
          resolved_by: string | null
          result: Json | null
          review_note: string | null
          review_resolution: string | null
          schema_version: number
          status: string
          succeeded_at: string | null
          updated_at: string
        }
        Insert: {
          actor_id: string
          attempt_count?: number
          client_action_id: string
          client_created_at: string
          created_at?: string
          entity_id: string
          entity_snapshot_at?: string | null
          failure_code?: string | null
          failure_summary?: string | null
          idempotency_key: string
          last_attempt_at?: string | null
          needs_review_at?: string | null
          operation: string
          received_at?: string
          request_payload: Json
          resolved_at?: string | null
          resolved_by?: string | null
          result?: Json | null
          review_note?: string | null
          review_resolution?: string | null
          schema_version: number
          status?: string
          succeeded_at?: string | null
          updated_at?: string
        }
        Update: {
          actor_id?: string
          attempt_count?: number
          client_action_id?: string
          client_created_at?: string
          created_at?: string
          entity_id?: string
          entity_snapshot_at?: string | null
          failure_code?: string | null
          failure_summary?: string | null
          idempotency_key?: string
          last_attempt_at?: string | null
          needs_review_at?: string | null
          operation?: string
          received_at?: string
          request_payload?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          result?: Json | null
          review_note?: string | null
          review_resolution?: string | null
          schema_version?: number
          status?: string
          succeeded_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offline_action_receipts_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offline_action_receipts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      order_item_field_allocations: {
        Row: {
          acres: number
          created_at: string
          field_id: string
          id: string
          order_item_id: string
        }
        Insert: {
          acres: number
          created_at?: string
          field_id: string
          id?: string
          order_item_id: string
        }
        Update: {
          acres?: number
          created_at?: string
          field_id?: string
          id?: string
          order_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_item_field_allocations_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_item_field_allocations_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          acres: number | null
          actual_rate: number | null
          cost_at_time_cents: number | null
          cost_per_unit: number
          id: string
          net_margin: number
          notes: string | null
          order_id: string
          price_per_unit: number
          pricing_pending: boolean
          product_id: string
          product_name: string
          profit: number
          quantity_delivered: number
          quantity_remaining: number
          quote_item_id: string | null
          rate_unit: string | null
          section_name: string | null
          sort_order: number | null
          suggested_price: number | null
          total_price: number
          total_units_needed: number
          unit_size: string | null
        }
        Insert: {
          acres?: number | null
          actual_rate?: number | null
          cost_at_time_cents?: number | null
          cost_per_unit?: number
          id?: string
          net_margin?: number
          notes?: string | null
          order_id: string
          price_per_unit?: number
          pricing_pending?: boolean
          product_id: string
          product_name?: string
          profit?: number
          quantity_delivered?: number
          quantity_remaining?: number
          quote_item_id?: string | null
          rate_unit?: string | null
          section_name?: string | null
          sort_order?: number | null
          suggested_price?: number | null
          total_price?: number
          total_units_needed?: number
          unit_size?: string | null
        }
        Update: {
          acres?: number | null
          actual_rate?: number | null
          cost_at_time_cents?: number | null
          cost_per_unit?: number
          id?: string
          net_margin?: number
          notes?: string | null
          order_id?: string
          price_per_unit?: number
          pricing_pending?: boolean
          product_id?: string
          product_name?: string
          profit?: number
          quantity_delivered?: number
          quantity_remaining?: number
          quote_item_id?: string | null
          rate_unit?: string | null
          section_name?: string | null
          sort_order?: number | null
          suggested_price?: number | null
          total_price?: number
          total_units_needed?: number
          unit_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_quote_item_id_fkey"
            columns: ["quote_item_id"]
            isOneToOne: false
            referencedRelation: "quote_items"
            referencedColumns: ["id"]
          },
        ]
      }
      order_line_allocations: {
        Row: {
          allocation_set_id: string
          amount_cents: number
          bill_to_customer_id: string
          created_at: string
          id: string
          order_item_id: string
          split_percentage: number
        }
        Insert: {
          allocation_set_id: string
          amount_cents: number
          bill_to_customer_id: string
          created_at?: string
          id?: string
          order_item_id: string
          split_percentage: number
        }
        Update: {
          allocation_set_id?: string
          amount_cents?: number
          bill_to_customer_id?: string
          created_at?: string
          id?: string
          order_item_id?: string
          split_percentage?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_line_allocations_allocation_set_id_fkey"
            columns: ["allocation_set_id"]
            isOneToOne: false
            referencedRelation: "allocation_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_line_allocations_bill_to_customer_id_fkey"
            columns: ["bill_to_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_line_allocations_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      order_shares: {
        Row: {
          amount_cents: number
          created_at: string
          customer_id: string
          customer_name: string
          id: string
          is_primary: boolean | null
          order_id: string
          sort_order: number | null
          split_percentage: number
        }
        Insert: {
          amount_cents: number
          created_at?: string
          customer_id: string
          customer_name: string
          id?: string
          is_primary?: boolean | null
          order_id: string
          sort_order?: number | null
          split_percentage: number
        }
        Update: {
          amount_cents?: number
          created_at?: string
          customer_id?: string
          customer_name?: string
          id?: string
          is_primary?: boolean | null
          order_id?: string
          sort_order?: number | null
          split_percentage?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_shares_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          booking_draw: boolean
          commission_split: Json | null
          created_at: string
          customer_id: string
          customer_po_number: string | null
          deleted_at: string | null
          id: string
          is_planned: boolean
          needs_split_billing: boolean | null
          notes: string | null
          order_date: string
          order_name: string | null
          order_number: string
          pricing_escalation_sent_at: string | null
          pricing_reminder_sent_at: string | null
          pricing_status: string
          program_notes: string | null
          quote_id: string | null
          salesman_id: string | null
          season: number | null
          status: string
          total_cost: number
          total_margin_pct: number
          total_price: number
          total_profit: number
          updated_at: string
        }
        Insert: {
          booking_draw?: boolean
          commission_split?: Json | null
          created_at?: string
          customer_id: string
          customer_po_number?: string | null
          deleted_at?: string | null
          id?: string
          is_planned?: boolean
          needs_split_billing?: boolean | null
          notes?: string | null
          order_date?: string
          order_name?: string | null
          order_number: string
          pricing_escalation_sent_at?: string | null
          pricing_reminder_sent_at?: string | null
          pricing_status?: string
          program_notes?: string | null
          quote_id?: string | null
          salesman_id?: string | null
          season?: number | null
          status?: string
          total_cost?: number
          total_margin_pct?: number
          total_price?: number
          total_profit?: number
          updated_at?: string
        }
        Update: {
          booking_draw?: boolean
          commission_split?: Json | null
          created_at?: string
          customer_id?: string
          customer_po_number?: string | null
          deleted_at?: string | null
          id?: string
          is_planned?: boolean
          needs_split_billing?: boolean | null
          notes?: string | null
          order_date?: string
          order_name?: string | null
          order_number?: string
          pricing_escalation_sent_at?: string | null
          pricing_reminder_sent_at?: string | null
          pricing_status?: string
          program_notes?: string | null
          quote_id?: string | null
          salesman_id?: string | null
          season?: number | null
          status?: string
          total_cost?: number
          total_margin_pct?: number
          total_price?: number
          total_profit?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_salesman_id_fkey"
            columns: ["salesman_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          customer_id: string
          deleted_at: string | null
          id: string
          notes: string | null
          order_id: string | null
          payment_date: string
          payment_method: string
          recorded_by: string
          reference_number: string | null
          season: number | null
        }
        Insert: {
          amount?: number
          created_at?: string
          customer_id: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          order_id?: string | null
          payment_date?: string
          payment_method?: string
          recorded_by: string
          reference_number?: string | null
          season?: number | null
        }
        Update: {
          amount?: number
          created_at?: string
          customer_id?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          order_id?: string | null
          payment_date?: string
          payment_method?: string
          recorded_by?: string
          reference_number?: string | null
          season?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      prepay_applications: {
        Row: {
          applied_amount_cents: number
          applied_at: string
          applied_by: string | null
          id: string
          invoice_id: string
          prepay_credit_id: string
        }
        Insert: {
          applied_amount_cents: number
          applied_at?: string
          applied_by?: string | null
          id?: string
          invoice_id: string
          prepay_credit_id: string
        }
        Update: {
          applied_amount_cents?: number
          applied_at?: string
          applied_by?: string | null
          id?: string
          invoice_id?: string
          prepay_credit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prepay_applications_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepay_applications_prepay_credit_id_fkey"
            columns: ["prepay_credit_id"]
            isOneToOne: false
            referencedRelation: "prepay_credits"
            referencedColumns: ["id"]
          },
        ]
      }
      prepay_credits: {
        Row: {
          allocation_set_id: string | null
          balance_cents: number
          bucket_label: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          notes: string | null
          original_amount_cents: number
          payment_method: string | null
          quote_id: string | null
          reference_number: string | null
          season: number
          source_reference: string | null
          source_type: string | null
          updated_at: string
        }
        Insert: {
          allocation_set_id?: string | null
          balance_cents: number
          bucket_label?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          notes?: string | null
          original_amount_cents: number
          payment_method?: string | null
          quote_id?: string | null
          reference_number?: string | null
          season?: number
          source_reference?: string | null
          source_type?: string | null
          updated_at?: string
        }
        Update: {
          allocation_set_id?: string | null
          balance_cents?: number
          bucket_label?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          notes?: string | null
          original_amount_cents?: number
          payment_method?: string | null
          quote_id?: string | null
          reference_number?: string | null
          season?: number
          source_reference?: string | null
          source_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prepay_credits_allocation_set_id_fkey"
            columns: ["allocation_set_id"]
            isOneToOne: false
            referencedRelation: "allocation_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepay_credits_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepay_credits_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_change_set_preview_rows: {
        Row: {
          change_set_id: string
          effect: Json | null
          error_code: string | null
          product_id: string | null
          row_status: string
          sequence: number
          submitted_row: Json
        }
        Insert: {
          change_set_id: string
          effect?: Json | null
          error_code?: string | null
          product_id?: string | null
          row_status: string
          sequence: number
          submitted_row: Json
        }
        Update: {
          change_set_id?: string
          effect?: Json | null
          error_code?: string | null
          product_id?: string | null
          row_status?: string
          sequence?: number
          submitted_row?: Json
        }
        Relationships: [
          {
            foreignKeyName: "pricing_change_set_preview_rows_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_set_preview_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_set_preview_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_change_set_rows: {
        Row: {
          change_reason: string | null
          change_set_id: string
          expected_version: number
          identity_fingerprint: string
          input_cost_cents: number
          input_tier1_margin: number | null
          input_tier1_price_cents: number | null
          input_tier2_margin: number | null
          input_tier2_price_cents: number | null
          input_tier3_margin: number | null
          input_tier3_price_cents: number | null
          output_cost_cents: number
          output_fingerprint: string
          output_tier1_gross_margin: number | null
          output_tier1_margin: number
          output_tier1_price_cents: number
          output_tier1_price_per_acre_cents: number | null
          output_tier2_gross_margin: number | null
          output_tier2_margin: number
          output_tier2_price_cents: number
          output_tier2_price_per_acre_cents: number | null
          output_tier3_gross_margin: number | null
          output_tier3_margin: number
          output_tier3_price_cents: number
          output_tier3_price_per_acre_cents: number | null
          pricing_mode: string
          product_id: string
        }
        Insert: {
          change_reason?: string | null
          change_set_id: string
          expected_version: number
          identity_fingerprint: string
          input_cost_cents: number
          input_tier1_margin?: number | null
          input_tier1_price_cents?: number | null
          input_tier2_margin?: number | null
          input_tier2_price_cents?: number | null
          input_tier3_margin?: number | null
          input_tier3_price_cents?: number | null
          output_cost_cents: number
          output_fingerprint: string
          output_tier1_gross_margin?: number | null
          output_tier1_margin: number
          output_tier1_price_cents: number
          output_tier1_price_per_acre_cents?: number | null
          output_tier2_gross_margin?: number | null
          output_tier2_margin: number
          output_tier2_price_cents: number
          output_tier2_price_per_acre_cents?: number | null
          output_tier3_gross_margin?: number | null
          output_tier3_margin: number
          output_tier3_price_cents: number
          output_tier3_price_per_acre_cents?: number | null
          pricing_mode: string
          product_id: string
        }
        Update: {
          change_reason?: string | null
          change_set_id?: string
          expected_version?: number
          identity_fingerprint?: string
          input_cost_cents?: number
          input_tier1_margin?: number | null
          input_tier1_price_cents?: number | null
          input_tier2_margin?: number | null
          input_tier2_price_cents?: number | null
          input_tier3_margin?: number | null
          input_tier3_price_cents?: number | null
          output_cost_cents?: number
          output_fingerprint?: string
          output_tier1_gross_margin?: number | null
          output_tier1_margin?: number
          output_tier1_price_cents?: number
          output_tier1_price_per_acre_cents?: number | null
          output_tier2_gross_margin?: number | null
          output_tier2_margin?: number
          output_tier2_price_cents?: number
          output_tier2_price_per_acre_cents?: number | null
          output_tier3_gross_margin?: number | null
          output_tier3_margin?: number
          output_tier3_price_cents?: number
          output_tier3_price_per_acre_cents?: number | null
          pricing_mode?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pricing_change_set_rows_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_set_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_set_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_change_sets: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          apply_idempotency_key: string | null
          apply_result: Json | null
          created_at: string
          created_by: string
          expires_at: string
          export_id: string | null
          id: string
          preview_idempotency_key: string
          request_fingerprint: string
          row_count: number
          source: string
          status: string
          submitted_row_count: number
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          apply_idempotency_key?: string | null
          apply_result?: Json | null
          created_at?: string
          created_by: string
          expires_at?: string
          export_id?: string | null
          id?: string
          preview_idempotency_key: string
          request_fingerprint: string
          row_count?: number
          source: string
          status?: string
          submitted_row_count: number
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          apply_idempotency_key?: string | null
          apply_result?: Json | null
          created_at?: string
          created_by?: string
          expires_at?: string
          export_id?: string | null
          id?: string
          preview_idempotency_key?: string
          request_fingerprint?: string
          row_count?: number
          source?: string
          status?: string
          submitted_row_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "pricing_change_sets_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_sets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_change_sets_export_id_fkey"
            columns: ["export_id"]
            isOneToOne: false
            referencedRelation: "pricing_workbook_exports"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_workbook_export_rows: {
        Row: {
          category_snapshot: string | null
          container_size_snapshot: string | null
          current_cost_cents: number | null
          current_tier1_margin: number | null
          current_tier1_price_cents: number | null
          current_tier2_margin: number | null
          current_tier2_price_cents: number | null
          current_tier3_margin: number | null
          current_tier3_price_cents: number | null
          export_id: string
          identity_fingerprint: string
          internal_notes_snapshot: string | null
          inventory_unit_snapshot: string | null
          product_id: string
          product_name_snapshot: string
          quoting_notes_snapshot: string | null
          rate_per_acre_snapshot: number | null
          rate_unit_snapshot: string | null
          row_token: string
          row_version: number
          sku_snapshot: string | null
          suggested_rate_snapshot: string | null
          unit_size_snapshot: string | null
          use_timing_snapshot: string | null
        }
        Insert: {
          category_snapshot?: string | null
          container_size_snapshot?: string | null
          current_cost_cents?: number | null
          current_tier1_margin?: number | null
          current_tier1_price_cents?: number | null
          current_tier2_margin?: number | null
          current_tier2_price_cents?: number | null
          current_tier3_margin?: number | null
          current_tier3_price_cents?: number | null
          export_id: string
          identity_fingerprint: string
          internal_notes_snapshot?: string | null
          inventory_unit_snapshot?: string | null
          product_id: string
          product_name_snapshot: string
          quoting_notes_snapshot?: string | null
          rate_per_acre_snapshot?: number | null
          rate_unit_snapshot?: string | null
          row_token: string
          row_version: number
          sku_snapshot?: string | null
          suggested_rate_snapshot?: string | null
          unit_size_snapshot?: string | null
          use_timing_snapshot?: string | null
        }
        Update: {
          category_snapshot?: string | null
          container_size_snapshot?: string | null
          current_cost_cents?: number | null
          current_tier1_margin?: number | null
          current_tier1_price_cents?: number | null
          current_tier2_margin?: number | null
          current_tier2_price_cents?: number | null
          current_tier3_margin?: number | null
          current_tier3_price_cents?: number | null
          export_id?: string
          identity_fingerprint?: string
          internal_notes_snapshot?: string | null
          inventory_unit_snapshot?: string | null
          product_id?: string
          product_name_snapshot?: string
          quoting_notes_snapshot?: string | null
          rate_per_acre_snapshot?: number | null
          rate_unit_snapshot?: string | null
          row_token?: string
          row_version?: number
          sku_snapshot?: string | null
          suggested_rate_snapshot?: string | null
          unit_size_snapshot?: string | null
          use_timing_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_workbook_export_rows_export_id_fkey"
            columns: ["export_id"]
            isOneToOne: false
            referencedRelation: "pricing_workbook_exports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_workbook_export_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_workbook_export_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_workbook_exports: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string
          format_version: string
          id: string
          idempotency_key: string
          manifest_fingerprint: string
          request_fingerprint: string
          row_count: number
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string
          format_version?: string
          id?: string
          idempotency_key: string
          manifest_fingerprint: string
          request_fingerprint: string
          row_count: number
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string
          format_version?: string
          id?: string
          idempotency_key?: string
          manifest_fingerprint?: string
          request_fingerprint?: string
          row_count?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pricing_workbook_exports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      product_cost_basis: {
        Row: {
          basis_type: string
          cost_cents: number
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          pricing_change_set_id: string | null
          product_id: string
          purchase_order_item_id: string | null
          reason: string
          selected_at: string
          selected_by: string | null
          selection_source: string
          supplier_price_observation_id: string | null
        }
        Insert: {
          basis_type: string
          cost_cents: number
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          pricing_change_set_id?: string | null
          product_id: string
          purchase_order_item_id?: string | null
          reason: string
          selected_at?: string
          selected_by?: string | null
          selection_source: string
          supplier_price_observation_id?: string | null
        }
        Update: {
          basis_type?: string
          cost_cents?: number
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          pricing_change_set_id?: string | null
          product_id?: string
          purchase_order_item_id?: string | null
          reason?: string
          selected_at?: string
          selected_by?: string | null
          selection_source?: string
          supplier_price_observation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_cost_basis_pricing_change_set_id_fkey"
            columns: ["pricing_change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_purchase_order_item_id_fkey"
            columns: ["purchase_order_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_selected_by_fkey"
            columns: ["selected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_supplier_price_observation_id_fkey"
            columns: ["supplier_price_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_observations"
            referencedColumns: ["id"]
          },
        ]
      }
      product_cost_basis_change_rows: {
        Row: {
          basis_type: string
          cost_cents: number
          created_at: string
          expected_active_basis_id: string | null
          expected_version: number
          force_selection: boolean
          pricing_change_set_id: string
          product_id: string
          purchase_order_item_id: string | null
          reason: string
          selection_source: string
          supplier_price_observation_id: string | null
        }
        Insert: {
          basis_type: string
          cost_cents: number
          created_at?: string
          expected_active_basis_id?: string | null
          expected_version: number
          force_selection?: boolean
          pricing_change_set_id: string
          product_id: string
          purchase_order_item_id?: string | null
          reason: string
          selection_source: string
          supplier_price_observation_id?: string | null
        }
        Update: {
          basis_type?: string
          cost_cents?: number
          created_at?: string
          expected_active_basis_id?: string | null
          expected_version?: number
          force_selection?: boolean
          pricing_change_set_id?: string
          product_id?: string
          purchase_order_item_id?: string | null
          reason?: string
          selection_source?: string
          supplier_price_observation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_cost_basis_change_row_supplier_price_observation_i_fkey"
            columns: ["supplier_price_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_change_rows_expected_active_basis_id_fkey"
            columns: ["expected_active_basis_id"]
            isOneToOne: false
            referencedRelation: "product_cost_basis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_change_rows_pricing_change_set_id_fkey"
            columns: ["pricing_change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_change_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_change_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_change_rows_purchase_order_item_id_fkey"
            columns: ["purchase_order_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      product_cost_basis_rollout: {
        Row: {
          created_at: string
          product_id: string
          rollout_scope: string
        }
        Insert: {
          created_at?: string
          product_id: string
          rollout_scope: string
        }
        Update: {
          created_at?: string
          product_id?: string
          rollout_scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_cost_basis_rollout_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_cost_basis_rollout_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_families: {
        Row: {
          active_ingredient: string | null
          created_at: string
          description: string | null
          formulation: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          active_ingredient?: string | null
          created_at?: string
          description?: string | null
          formulation?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          active_ingredient?: string | null
          created_at?: string
          description?: string | null
          formulation?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      product_info_change_set_rows: {
        Row: {
          after_values: Json
          before_values: Json
          change_set_id: string
          changes: Json
          expected_version: number
          output_fingerprint: string
          product_id: string
        }
        Insert: {
          after_values: Json
          before_values: Json
          change_set_id: string
          changes: Json
          expected_version: number
          output_fingerprint: string
          product_id: string
        }
        Update: {
          after_values?: Json
          before_values?: Json
          change_set_id?: string
          changes?: Json
          expected_version?: number
          output_fingerprint?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_info_change_set_rows_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "pricing_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_info_change_set_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_info_change_set_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_label_drafts: {
        Row: {
          confidence: string
          created_at: string
          created_by: string
          epa_registration: string | null
          id: string
          max_label_rate: number | null
          max_label_rate_unit: string | null
          phi_days: number | null
          product_id: string
          rei_hours: number | null
          reviewed_at: string | null
          reviewed_by: string | null
          run_idempotency_key: string | null
          signal_word: string | null
          source_note: string
          status: string
          updated_at: string
        }
        Insert: {
          confidence?: string
          created_at?: string
          created_by: string
          epa_registration?: string | null
          id?: string
          max_label_rate?: number | null
          max_label_rate_unit?: string | null
          phi_days?: number | null
          product_id: string
          rei_hours?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_idempotency_key?: string | null
          signal_word?: string | null
          source_note?: string
          status?: string
          updated_at?: string
        }
        Update: {
          confidence?: string
          created_at?: string
          created_by?: string
          epa_registration?: string | null
          id?: string
          max_label_rate?: number | null
          max_label_rate_unit?: string | null
          phi_days?: number | null
          product_id?: string
          rei_hours?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_idempotency_key?: string | null
          signal_word?: string | null
          source_note?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_label_drafts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_label_drafts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_supplier_links: {
        Row: {
          comparison_note: string | null
          comparison_status: string
          confirmed_at: string | null
          confirmed_by: string | null
          conversion_factor: number | null
          conversion_unit: string | null
          created_at: string
          created_by: string
          id: string
          inventory_units_per_supplier_unit: number | null
          is_active: boolean
          is_preferred: boolean
          is_reusable: boolean | null
          link_status: string
          match_confidence: number | null
          product_id: string
          supplier_pack_description: string | null
          supplier_product_name: string
          supplier_sku: string | null
          supplier_uom: string | null
          updated_at: string
          vendor_id: string
        }
        Insert: {
          comparison_note?: string | null
          comparison_status?: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          conversion_factor?: number | null
          conversion_unit?: string | null
          created_at?: string
          created_by: string
          id?: string
          inventory_units_per_supplier_unit?: number | null
          is_active?: boolean
          is_preferred?: boolean
          is_reusable?: boolean | null
          link_status?: string
          match_confidence?: number | null
          product_id: string
          supplier_pack_description?: string | null
          supplier_product_name: string
          supplier_sku?: string | null
          supplier_uom?: string | null
          updated_at?: string
          vendor_id: string
        }
        Update: {
          comparison_note?: string | null
          comparison_status?: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          conversion_factor?: number | null
          conversion_unit?: string | null
          created_at?: string
          created_by?: string
          id?: string
          inventory_units_per_supplier_unit?: number | null
          is_active?: boolean
          is_preferred?: boolean
          is_reusable?: boolean | null
          link_status?: string
          match_confidence?: number | null
          product_id?: string
          supplier_pack_description?: string | null
          supplier_product_name?: string
          supplier_sku?: string | null
          supplier_uom?: string | null
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_supplier_links_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_supplier_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_supplier_links_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_supplier_links_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_supplier_links_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          category: string | null
          container_size: number | null
          container_type: string | null
          container_unit: string | null
          cost_updated_date: string | null
          created_at: string
          current_cost: number | null
          epa_registration: string | null
          id: string
          internal_notes: string | null
          inventory_unit: string | null
          is_active: boolean
          is_full_tote_only: boolean
          is_rup: boolean
          manufacturer: string | null
          max_label_rate: number | null
          max_label_rate_unit: string | null
          notes: string | null
          packaging_variant: string | null
          phi_days: number | null
          pricing_version: number
          product_family_id: string | null
          product_form: string | null
          product_name: string
          quoting_notes: string | null
          rate_per_acre: number | null
          rate_unit: string | null
          rei_hours: number | null
          return_policy: string
          signal_word: string | null
          sku: string | null
          suggested_rate: string | null
          tier1_gross_margin: number | null
          tier1_margin: number | null
          tier1_price: number | null
          tier1_price_per_acre: number | null
          tier2_gross_margin: number | null
          tier2_margin: number | null
          tier2_price: number | null
          tier2_price_per_acre: number | null
          tier3_gross_margin: number | null
          tier3_margin: number | null
          tier3_price: number | null
          tier3_price_per_acre: number | null
          unit_size: string | null
          updated_at: string
          use_timing: string | null
          vendor: string | null
        }
        Insert: {
          category?: string | null
          container_size?: number | null
          container_type?: string | null
          container_unit?: string | null
          cost_updated_date?: string | null
          created_at?: string
          current_cost?: number | null
          epa_registration?: string | null
          id?: string
          internal_notes?: string | null
          inventory_unit?: string | null
          is_active?: boolean
          is_full_tote_only?: boolean
          is_rup?: boolean
          manufacturer?: string | null
          max_label_rate?: number | null
          max_label_rate_unit?: string | null
          notes?: string | null
          packaging_variant?: string | null
          phi_days?: number | null
          pricing_version?: number
          product_family_id?: string | null
          product_form?: string | null
          product_name: string
          quoting_notes?: string | null
          rate_per_acre?: number | null
          rate_unit?: string | null
          rei_hours?: number | null
          return_policy?: string
          signal_word?: string | null
          sku?: string | null
          suggested_rate?: string | null
          tier1_gross_margin?: number | null
          tier1_margin?: number | null
          tier1_price?: number | null
          tier1_price_per_acre?: number | null
          tier2_gross_margin?: number | null
          tier2_margin?: number | null
          tier2_price?: number | null
          tier2_price_per_acre?: number | null
          tier3_gross_margin?: number | null
          tier3_margin?: number | null
          tier3_price?: number | null
          tier3_price_per_acre?: number | null
          unit_size?: string | null
          updated_at?: string
          use_timing?: string | null
          vendor?: string | null
        }
        Update: {
          category?: string | null
          container_size?: number | null
          container_type?: string | null
          container_unit?: string | null
          cost_updated_date?: string | null
          created_at?: string
          current_cost?: number | null
          epa_registration?: string | null
          id?: string
          internal_notes?: string | null
          inventory_unit?: string | null
          is_active?: boolean
          is_full_tote_only?: boolean
          is_rup?: boolean
          manufacturer?: string | null
          max_label_rate?: number | null
          max_label_rate_unit?: string | null
          notes?: string | null
          packaging_variant?: string | null
          phi_days?: number | null
          pricing_version?: number
          product_family_id?: string | null
          product_form?: string | null
          product_name?: string
          quoting_notes?: string | null
          rate_per_acre?: number | null
          rate_unit?: string | null
          rei_hours?: number | null
          return_policy?: string
          signal_word?: string | null
          sku?: string | null
          suggested_rate?: string | null
          tier1_gross_margin?: number | null
          tier1_margin?: number | null
          tier1_price?: number | null
          tier1_price_per_acre?: number | null
          tier2_gross_margin?: number | null
          tier2_margin?: number | null
          tier2_price?: number | null
          tier2_price_per_acre?: number | null
          tier3_gross_margin?: number | null
          tier3_margin?: number | null
          tier3_price?: number | null
          tier3_price_per_acre?: number | null
          unit_size?: string | null
          updated_at?: string
          use_timing?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_product_family_id_fkey"
            columns: ["product_family_id"]
            isOneToOne: false
            referencedRelation: "product_families"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_public_directory: {
        Row: {
          full_name: string
          id: string
          is_active: boolean
          role: string
        }
        Insert: {
          full_name: string
          id: string
          is_active?: boolean
          role: string
        }
        Update: {
          full_name?: string
          id?: string
          is_active?: boolean
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_public_directory_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          applicator_license_number: string | null
          created_at: string
          denied_pages: string[]
          email: string
          faa_certificate_number: string | null
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          applicator_license_number?: string | null
          created_at?: string
          denied_pages?: string[]
          email: string
          faa_certificate_number?: string | null
          full_name?: string
          id: string
          is_active?: boolean
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          applicator_license_number?: string | null
          created_at?: string
          denied_pages?: string[]
          email?: string
          faa_certificate_number?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      purchase_order_import_intents: {
        Row: {
          actor_id: string
          content_fingerprint: string | null
          created_at: string
          id: string
          intent_key: string
          purchase_order_id: string
        }
        Insert: {
          actor_id: string
          content_fingerprint?: string | null
          created_at?: string
          id?: string
          intent_key: string
          purchase_order_id: string
        }
        Update: {
          actor_id?: string
          content_fingerprint?: string | null
          created_at?: string
          id?: string
          intent_key?: string
          purchase_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_import_intents_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_import_intents_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: true
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          cost_provenance: string | null
          cost_snapshot_at: string | null
          id: string
          inventory_unit_snapshot: string | null
          inventory_units_per_supplier_unit_snapshot: number | null
          notes: string | null
          product_id: string
          product_name: string | null
          product_supplier_link_id: string | null
          purchase_order_id: string
          quantity_ordered: number
          quantity_received: number
          supplier_price_observation_id: string | null
          unit_cost: number
          unit_cost_cents: number | null
          unit_size: string | null
        }
        Insert: {
          cost_provenance?: string | null
          cost_snapshot_at?: string | null
          id?: string
          inventory_unit_snapshot?: string | null
          inventory_units_per_supplier_unit_snapshot?: number | null
          notes?: string | null
          product_id: string
          product_name?: string | null
          product_supplier_link_id?: string | null
          purchase_order_id: string
          quantity_ordered?: number
          quantity_received?: number
          supplier_price_observation_id?: string | null
          unit_cost?: number
          unit_cost_cents?: number | null
          unit_size?: string | null
        }
        Update: {
          cost_provenance?: string | null
          cost_snapshot_at?: string | null
          id?: string
          inventory_unit_snapshot?: string | null
          inventory_units_per_supplier_unit_snapshot?: number | null
          notes?: string | null
          product_id?: string
          product_name?: string | null
          product_supplier_link_id?: string | null
          purchase_order_id?: string
          quantity_ordered?: number
          quantity_received?: number
          supplier_price_observation_id?: string | null
          unit_cost?: number
          unit_cost_cents?: number | null
          unit_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_product_supplier_link_id_fkey"
            columns: ["product_supplier_link_id"]
            isOneToOne: false
            referencedRelation: "product_supplier_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_supplier_price_observation_id_fkey"
            columns: ["supplier_price_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_observations"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          expected_delivery_date: string | null
          id: string
          notes: string | null
          po_number: string
          status: string
          submitted_date: string | null
          total_cost: number
          total_cost_cents: number | null
          updated_at: string
          vendor: string
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by: string
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          po_number: string
          status?: string
          submitted_date?: string | null
          total_cost?: number
          total_cost_cents?: number | null
          updated_at?: string
          vendor?: string
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by?: string
          expected_delivery_date?: string | null
          id?: string
          notes?: string | null
          po_number?: string
          status?: string
          submitted_date?: string | null
          total_cost?: number
          total_cost_cents?: number | null
          updated_at?: string
          vendor?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_items: {
        Row: {
          acres: number | null
          actual_rate: number | null
          calc_mode: string | null
          current_cost: number
          id: string
          net_margin: number
          notes: string | null
          oz_per_acre: number | null
          price_override: number | null
          price_per_acre: number | null
          price_per_unit: number
          price_unit: string | null
          product_id: string
          profit: number
          quote_id: string
          rate_unit: string | null
          section_id: string
          sort_order: number
          suggested_rate: string | null
          total_price: number
          total_units_needed: number | null
          unit_size: string | null
        }
        Insert: {
          acres?: number | null
          actual_rate?: number | null
          calc_mode?: string | null
          current_cost?: number
          id?: string
          net_margin?: number
          notes?: string | null
          oz_per_acre?: number | null
          price_override?: number | null
          price_per_acre?: number | null
          price_per_unit?: number
          price_unit?: string | null
          product_id: string
          profit?: number
          quote_id: string
          rate_unit?: string | null
          section_id: string
          sort_order?: number
          suggested_rate?: string | null
          total_price?: number
          total_units_needed?: number | null
          unit_size?: string | null
        }
        Update: {
          acres?: number | null
          actual_rate?: number | null
          calc_mode?: string | null
          current_cost?: number
          id?: string
          net_margin?: number
          notes?: string | null
          oz_per_acre?: number | null
          price_override?: number | null
          price_per_acre?: number | null
          price_per_unit?: number
          price_unit?: string | null
          product_id?: string
          profit?: number
          quote_id?: string
          rate_unit?: string | null
          section_id?: string
          sort_order?: number
          suggested_rate?: string | null
          total_price?: number
          total_units_needed?: number | null
          unit_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "quote_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_pdf_templates: {
        Row: {
          columns: Json
          created_at: string
          created_by: string | null
          id: string
          is_default: boolean
          is_system: boolean
          template_name: string
          updated_at: string
        }
        Insert: {
          columns?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          is_system?: boolean
          template_name: string
          updated_at?: string
        }
        Update: {
          columns?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          is_system?: boolean
          template_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_pdf_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_product_draws: {
        Row: {
          created_at: string
          id: string
          product_id: string
          quantity_drawn: number
          quote_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          quantity_drawn?: number
          quote_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          quantity_drawn?: number
          quote_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_product_draws_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_product_draws_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_product_draws_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_sections: {
        Row: {
          field_id: string | null
          id: string
          needed_by_date: string | null
          quote_id: string
          section_header_notes: string | null
          section_name: string
          section_notes: string | null
          sort_order: number
        }
        Insert: {
          field_id?: string | null
          id?: string
          needed_by_date?: string | null
          quote_id: string
          section_header_notes?: string | null
          section_name?: string
          section_notes?: string | null
          sort_order?: number
        }
        Update: {
          field_id?: string | null
          id?: string
          needed_by_date?: string | null
          quote_id?: string
          section_header_notes?: string | null
          section_name?: string
          section_notes?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_sections_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_sections_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_templates: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          sections: Json
          template_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          sections?: Json
          template_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          sections?: Json
          template_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_versions: {
        Row: {
          id: string
          notes: string | null
          pdf_url: string | null
          quote_id: string
          sent_at: string
          sent_by: string
          sent_method: string | null
          snapshot_data: Json
          version_number: number
        }
        Insert: {
          id?: string
          notes?: string | null
          pdf_url?: string | null
          quote_id: string
          sent_at?: string
          sent_by: string
          sent_method?: string | null
          snapshot_data: Json
          version_number?: number
        }
        Update: {
          id?: string
          notes?: string | null
          pdf_url?: string | null
          quote_id?: string
          sent_at?: string
          sent_by?: string
          sent_method?: string | null
          snapshot_data?: Json
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_versions_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_versions_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          commission_split: Json | null
          created_at: string
          created_by: string
          customer_id: string
          deleted_at: string | null
          expires_at: string | null
          footer_notes: string | null
          header_notes: string | null
          id: string
          is_planned: boolean
          pdf_columns_override: Json | null
          pdf_template_id: string | null
          quote_number: string
          row_version: number
          salesman_id: string | null
          season: number | null
          sent_at: string | null
          status: string
          tier: number
          total_cost: number
          total_margin_pct: number
          total_price: number
          total_profit: number
          updated_at: string
          valid_days: number
        }
        Insert: {
          commission_split?: Json | null
          created_at?: string
          created_by: string
          customer_id: string
          deleted_at?: string | null
          expires_at?: string | null
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_planned?: boolean
          pdf_columns_override?: Json | null
          pdf_template_id?: string | null
          quote_number: string
          row_version?: number
          salesman_id?: string | null
          season?: number | null
          sent_at?: string | null
          status?: string
          tier?: number
          total_cost?: number
          total_margin_pct?: number
          total_price?: number
          total_profit?: number
          updated_at?: string
          valid_days?: number
        }
        Update: {
          commission_split?: Json | null
          created_at?: string
          created_by?: string
          customer_id?: string
          deleted_at?: string | null
          expires_at?: string | null
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_planned?: boolean
          pdf_columns_override?: Json | null
          pdf_template_id?: string | null
          quote_number?: string
          row_version?: number
          salesman_id?: string | null
          season?: number | null
          sent_at?: string | null
          status?: string
          tier?: number
          total_cost?: number
          total_margin_pct?: number
          total_price?: number
          total_profit?: number
          updated_at?: string
          valid_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "quotes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_pdf_template_id_fkey"
            columns: ["pdf_template_id"]
            isOneToOne: false
            referencedRelation: "quote_pdf_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_salesman_id_fkey"
            columns: ["salesman_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_log: {
        Row: {
          created_at: string | null
          id: string
          operation: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          operation: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          operation?: string
          user_id?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          action_name: string
          id: string
          request_count: number
          user_id: string
          window_start: string
        }
        Insert: {
          action_name: string
          id?: string
          request_count?: number
          user_id: string
          window_start?: string
        }
        Update: {
          action_name?: string
          id?: string
          request_count?: number
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      rebate_claim_counters: {
        Row: {
          next_value: number
          year: number
        }
        Insert: {
          next_value?: number
          year: number
        }
        Update: {
          next_value?: number
          year?: number
        }
        Relationships: []
      }
      rebate_claims: {
        Row: {
          approved_date: string | null
          claim_amount_cents: number
          claim_number: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          manufacturer_ref: string | null
          notes: string | null
          order_id: string | null
          paid_amount_cents: number | null
          paid_date: string | null
          product_id: string | null
          program_id: string
          quantity: number
          status: string
          submitted_date: string | null
          updated_at: string
        }
        Insert: {
          approved_date?: string | null
          claim_amount_cents?: number
          claim_number: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          manufacturer_ref?: string | null
          notes?: string | null
          order_id?: string | null
          paid_amount_cents?: number | null
          paid_date?: string | null
          product_id?: string | null
          program_id: string
          quantity?: number
          status?: string
          submitted_date?: string | null
          updated_at?: string
        }
        Update: {
          approved_date?: string | null
          claim_amount_cents?: number
          claim_number?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          manufacturer_ref?: string | null
          notes?: string | null
          order_id?: string | null
          paid_amount_cents?: number | null
          paid_date?: string | null
          product_id?: string | null
          program_id?: string
          quantity?: number
          status?: string
          submitted_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rebate_claims_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rebate_claims_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rebate_claims_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rebate_claims_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rebate_claims_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "rebate_programs"
            referencedColumns: ["id"]
          },
        ]
      }
      rebate_programs: {
        Row: {
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          manufacturer: string
          max_volume: number | null
          min_volume: number | null
          notes: string | null
          product_id: string | null
          program_name: string
          rebate_amount: number
          rebate_pct: number | null
          rebate_type: string
          season: number
          start_date: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          manufacturer: string
          max_volume?: number | null
          min_volume?: number | null
          notes?: string | null
          product_id?: string | null
          program_name: string
          rebate_amount?: number
          rebate_pct?: number | null
          rebate_type?: string
          season: number
          start_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          manufacturer?: string
          max_volume?: number | null
          min_volume?: number | null
          notes?: string | null
          product_id?: string | null
          program_name?: string
          rebate_amount?: number
          rebate_pct?: number | null
          rebate_type?: string
          season?: number
          start_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rebate_programs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rebate_programs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
        ]
      }
      receiving_photos: {
        Row: {
          caption: string | null
          file_size: number | null
          id: string
          image_url: string
          receiving_record_id: string
          sort_order: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          caption?: string | null
          file_size?: number | null
          id?: string
          image_url: string
          receiving_record_id: string
          sort_order?: number
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          caption?: string | null
          file_size?: number | null
          id?: string
          image_url?: string
          receiving_record_id?: string
          sort_order?: number
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "receiving_photos_receiving_record_id_fkey"
            columns: ["receiving_record_id"]
            isOneToOne: false
            referencedRelation: "receiving_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receiving_photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      receiving_records: {
        Row: {
          condition: string
          created_at: string
          id: string
          is_non_returnable: boolean
          lot_number: string | null
          notes: string | null
          po_item_id: string
          product_id: string
          purchase_order_id: string
          quantity_received: number
          received_at: string
          received_by: string
          storage_location: string
          unit_size: string | null
        }
        Insert: {
          condition?: string
          created_at?: string
          id?: string
          is_non_returnable?: boolean
          lot_number?: string | null
          notes?: string | null
          po_item_id: string
          product_id: string
          purchase_order_id: string
          quantity_received: number
          received_at?: string
          received_by: string
          storage_location?: string
          unit_size?: string | null
        }
        Update: {
          condition?: string
          created_at?: string
          id?: string
          is_non_returnable?: boolean
          lot_number?: string | null
          notes?: string | null
          po_item_id?: string
          product_id?: string
          purchase_order_id?: string
          quantity_received?: number
          received_at?: string
          received_by?: string
          storage_location?: string
          unit_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receiving_records_po_item_id_fkey"
            columns: ["po_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receiving_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receiving_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receiving_records_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receiving_records_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      return_items: {
        Row: {
          condition: string
          created_at: string
          extended_cents: number
          id: string
          notes: string | null
          order_item_id: string | null
          product_id: string
          product_name: string
          quantity: number
          restock: boolean
          restocked: boolean
          return_id: string
          sort_order: number
          unit: string
          unit_price_cents: number
        }
        Insert: {
          condition?: string
          created_at?: string
          extended_cents?: number
          id?: string
          notes?: string | null
          order_item_id?: string | null
          product_id: string
          product_name?: string
          quantity?: number
          restock?: boolean
          restocked?: boolean
          return_id: string
          sort_order?: number
          unit?: string
          unit_price_cents?: number
        }
        Update: {
          condition?: string
          created_at?: string
          extended_cents?: number
          id?: string
          notes?: string | null
          order_item_id?: string | null
          product_id?: string
          product_name?: string
          quantity?: number
          restock?: boolean
          restocked?: boolean
          return_id?: string
          sort_order?: number
          unit?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "return_items_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_items_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "returns"
            referencedColumns: ["id"]
          },
        ]
      }
      returns: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          credit_invoice_id: string | null
          credited_at: string | null
          credited_by: string | null
          customer_id: string
          deleted_at: string | null
          id: string
          notes: string | null
          order_id: string | null
          reason: string
          reason_notes: string | null
          received_at: string | null
          received_by: string | null
          requested_at: string
          requested_by: string
          return_number: string
          status: string
          total_credit_cents: number
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          credit_invoice_id?: string | null
          credited_at?: string | null
          credited_by?: string | null
          customer_id: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          order_id?: string | null
          reason?: string
          reason_notes?: string | null
          received_at?: string | null
          received_by?: string | null
          requested_at?: string
          requested_by?: string
          return_number: string
          status?: string
          total_credit_cents?: number
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          credit_invoice_id?: string | null
          credited_at?: string | null
          credited_by?: string | null
          customer_id?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          order_id?: string | null
          reason?: string
          reason_notes?: string | null
          received_at?: string | null
          received_by?: string | null
          requested_at?: string
          requested_by?: string
          return_number?: string
          status?: string
          total_credit_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "returns_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_credit_invoice_id_fkey"
            columns: ["credit_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "returns_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      rup_sales_records: {
        Row: {
          buyer_certification_expiry: string | null
          buyer_certification_number: string | null
          buyer_certification_type: string | null
          buyer_name: string
          compliance_notes: string | null
          compliance_status: string | null
          created_at: string | null
          created_by: string | null
          customer_id: string
          epa_registration: string | null
          id: string
          invoice_id: string | null
          order_id: string | null
          product_id: string
          product_name: string
          quantity: number
          sale_date: string
          season: number | null
          signal_word: string | null
          total_cents: number | null
          unit: string
          unit_price_cents: number | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          buyer_certification_expiry?: string | null
          buyer_certification_number?: string | null
          buyer_certification_type?: string | null
          buyer_name: string
          compliance_notes?: string | null
          compliance_status?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id: string
          epa_registration?: string | null
          id?: string
          invoice_id?: string | null
          order_id?: string | null
          product_id: string
          product_name: string
          quantity: number
          sale_date: string
          season?: number | null
          signal_word?: string | null
          total_cents?: number | null
          unit: string
          unit_price_cents?: number | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          buyer_certification_expiry?: string | null
          buyer_certification_number?: string | null
          buyer_certification_type?: string | null
          buyer_name?: string
          compliance_notes?: string | null
          compliance_status?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string
          epa_registration?: string | null
          id?: string
          invoice_id?: string | null
          order_id?: string | null
          product_id?: string
          product_name?: string
          quantity?: number
          sale_date?: string
          season?: number | null
          signal_word?: string | null
          total_cents?: number | null
          unit?: string
          unit_price_cents?: number | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rup_sales_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rup_sales_records_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      split_invoice_creation_claims: {
        Row: {
          claim_nonce: string
          created_at: string
          order_id: string
          transaction_id: unknown
        }
        Insert: {
          claim_nonce?: string
          created_at?: string
          order_id: string
          transaction_id: unknown
        }
        Update: {
          claim_nonce?: string
          created_at?: string
          order_id?: string
          transaction_id?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "split_invoice_creation_claims_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      split_invoice_mutation_claims: {
        Row: {
          created_at: string
          invoice_id: string
          operation: string
          transaction_id: unknown
        }
        Insert: {
          created_at?: string
          invoice_id: string
          operation: string
          transaction_id: unknown
        }
        Update: {
          created_at?: string
          invoice_id?: string
          operation?: string
          transaction_id?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "split_invoice_mutation_claims_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      split_invoice_provenance: {
        Row: {
          content_claim: Json
          contract_version: string
          created_at: string
          created_by: string
          customer_id: string
          invoice_group_id: string
          invoice_id: string
          invoice_type: string
          order_id: string
          provenance_nonce: string
          season: number
          total_amount_cents: number
        }
        Insert: {
          content_claim: Json
          contract_version?: string
          created_at?: string
          created_by: string
          customer_id: string
          invoice_group_id: string
          invoice_id: string
          invoice_type: string
          order_id: string
          provenance_nonce?: string
          season: number
          total_amount_cents: number
        }
        Update: {
          content_claim?: Json
          contract_version?: string
          created_at?: string
          created_by?: string
          customer_id?: string
          invoice_group_id?: string
          invoice_id?: string
          invoice_type?: string
          order_id?: string
          provenance_nonce?: string
          season?: number
          total_amount_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "split_invoice_provenance_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "split_invoice_provenance_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "split_invoice_provenance_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_price_import_rows: {
        Row: {
          cost_cents: number | null
          created_at: string
          effective_from: string | null
          effective_to: string | null
          id: string
          import_id: string
          observation_id: string | null
          package_quantity: number | null
          price_kind: string | null
          price_unit: string | null
          product_id: string | null
          product_supplier_link_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_note: string | null
          row_number: number
          row_status: string
          submitted_row: Json
          supplier_product_name: string | null
          supplier_sku: string | null
          updated_at: string
          validation_errors: string[]
          vendor_id: string | null
        }
        Insert: {
          cost_cents?: number | null
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          import_id: string
          observation_id?: string | null
          package_quantity?: number | null
          price_kind?: string | null
          price_unit?: string | null
          product_id?: string | null
          product_supplier_link_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          row_number: number
          row_status: string
          submitted_row: Json
          supplier_product_name?: string | null
          supplier_sku?: string | null
          updated_at?: string
          validation_errors?: string[]
          vendor_id?: string | null
        }
        Update: {
          cost_cents?: number | null
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          import_id?: string
          observation_id?: string | null
          package_quantity?: number | null
          price_kind?: string | null
          price_unit?: string | null
          product_id?: string | null
          product_supplier_link_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          row_number?: number
          row_status?: string
          submitted_row?: Json
          supplier_product_name?: string | null
          supplier_sku?: string | null
          updated_at?: string
          validation_errors?: string[]
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_price_import_rows_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_product_supplier_link_id_fkey"
            columns: ["product_supplier_link_id"]
            isOneToOne: false
            referencedRelation: "product_supplier_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_import_rows_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_price_imports: {
        Row: {
          approve_idempotency_key: string | null
          approve_request_fingerprint: string | null
          approved_at: string | null
          approved_by: string | null
          approved_observation_count: number
          created_at: string
          created_by: string
          document_date: string
          eligible_row_count: number
          format_version: string
          id: string
          idempotency_key: string
          ingestion_method: string
          reject_idempotency_key: string | null
          reject_request_fingerprint: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          request_fingerprint: string
          row_count: number
          source_document_mime: string | null
          source_document_name: string | null
          source_document_path: string | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          approve_idempotency_key?: string | null
          approve_request_fingerprint?: string | null
          approved_at?: string | null
          approved_by?: string | null
          approved_observation_count?: number
          created_at?: string
          created_by: string
          document_date: string
          eligible_row_count?: number
          format_version: string
          id?: string
          idempotency_key: string
          ingestion_method: string
          reject_idempotency_key?: string | null
          reject_request_fingerprint?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          request_fingerprint: string
          row_count?: number
          source_document_mime?: string | null
          source_document_name?: string | null
          source_document_path?: string | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          approve_idempotency_key?: string | null
          approve_request_fingerprint?: string | null
          approved_at?: string | null
          approved_by?: string | null
          approved_observation_count?: number
          created_at?: string
          created_by?: string
          document_date?: string
          eligible_row_count?: number
          format_version?: string
          id?: string
          idempotency_key?: string
          ingestion_method?: string
          reject_idempotency_key?: string | null
          reject_request_fingerprint?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          request_fingerprint?: string
          row_count?: number
          source_document_mime?: string | null
          source_document_name?: string | null
          source_document_path?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_price_imports_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_imports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_imports_rejected_by_fkey"
            columns: ["rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_imports_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_price_observations: {
        Row: {
          cost_cents: number
          created_at: string
          created_by: string
          effective_from: string
          effective_to: string | null
          id: string
          import_id: string
          import_row_id: string
          observed_at: string
          package_quantity: number
          price_kind: string
          price_unit: string
          product_id: string
          product_supplier_link_id: string
          supersedes_observation_id: string | null
          vendor_id: string
        }
        Insert: {
          cost_cents: number
          created_at?: string
          created_by: string
          effective_from: string
          effective_to?: string | null
          id?: string
          import_id: string
          import_row_id: string
          observed_at?: string
          package_quantity?: number
          price_kind: string
          price_unit: string
          product_id: string
          product_supplier_link_id: string
          supersedes_observation_id?: string | null
          vendor_id: string
        }
        Update: {
          cost_cents?: number
          created_at?: string
          created_by?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          import_id?: string
          import_row_id?: string
          observed_at?: string
          package_quantity?: number
          price_kind?: string
          price_unit?: string
          product_id?: string
          product_supplier_link_id?: string
          supersedes_observation_id?: string | null
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_price_observations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_import_row_id_fkey"
            columns: ["import_row_id"]
            isOneToOne: true
            referencedRelation: "supplier_price_import_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "view_unmigrated_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_product_supplier_link_id_fkey"
            columns: ["product_supplier_link_id"]
            isOneToOne: false
            referencedRelation: "product_supplier_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_supersedes_observation_id_fkey"
            columns: ["supersedes_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_price_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_price_observations_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      team_note_attachments: {
        Row: {
          created_at: string
          file_name: string
          file_size_bytes: number
          file_type: string
          file_url: string
          id: string
          note_id: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          file_name: string
          file_size_bytes: number
          file_type: string
          file_url: string
          id?: string
          note_id: string
          uploaded_by: string
        }
        Update: {
          created_at?: string
          file_name?: string
          file_size_bytes?: number
          file_type?: string
          file_url?: string
          id?: string
          note_id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_note_attachments_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "team_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_note_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_note_comments: {
        Row: {
          content: string
          created_at: string
          created_by: string
          deleted_at: string | null
          id: string
          mentions: string[] | null
          note_id: string
          parent_id: string | null
          updated_at: string | null
        }
        Insert: {
          content?: string
          created_at?: string
          created_by: string
          deleted_at?: string | null
          id?: string
          mentions?: string[] | null
          note_id: string
          parent_id?: string | null
          updated_at?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          id?: string
          mentions?: string[] | null
          note_id?: string
          parent_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_note_comments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_note_comments_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "team_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_note_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "team_note_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      team_note_tags: {
        Row: {
          created_at: string | null
          note_id: string
          tag_id: string
        }
        Insert: {
          created_at?: string | null
          note_id: string
          tag_id: string
        }
        Update: {
          created_at?: string | null
          note_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_note_tags_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "team_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_note_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "note_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      team_notes: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          completed_by: string | null
          content: string | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          due_date: string | null
          id: string
          is_completed: boolean
          is_pinned: boolean
          last_escalated_at: string | null
          linked_entity_id: string | null
          linked_entity_type: string | null
          note_type: string
          priority: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          content?: string | null
          created_at?: string
          created_by: string
          deleted_at?: string | null
          deleted_by?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean
          is_pinned?: boolean
          last_escalated_at?: string | null
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          note_type?: string
          priority?: string
          title?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          content?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean
          is_pinned?: boolean
          last_escalated_at?: string | null
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          note_type?: string
          priority?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_notes_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_notes_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_notes_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      unit_conversions: {
        Row: {
          factor_oz: number
          id: string
          notes: string | null
          unit: string
          unit_type: string
        }
        Insert: {
          factor_oz?: number
          id?: string
          notes?: string | null
          unit: string
          unit_type?: string
        }
        Update: {
          factor_oz?: number
          id?: string
          notes?: string | null
          unit?: string
          unit_type?: string
        }
        Relationships: []
      }
      user_list_settings: {
        Row: {
          created_at: string
          id: string
          list_key: string
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          list_key: string
          settings?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          list_key?: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_list_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          capacity_gallons: number | null
          capacity_unit: string | null
          category: string | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          registration: string | null
          status: string
          updated_at: string
          vehicle_name: string
          vehicle_type: string
        }
        Insert: {
          capacity_gallons?: number | null
          capacity_unit?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          registration?: string | null
          status?: string
          updated_at?: string
          vehicle_name: string
          vehicle_type: string
        }
        Update: {
          capacity_gallons?: number | null
          capacity_unit?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          registration?: string | null
          status?: string
          updated_at?: string
          vehicle_name?: string
          vehicle_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_alias_stage_receipts: {
        Row: {
          actor_id: string
          alias_id: string
          created_at: string
          idempotency_key: string
          request_fingerprint: string
          response: Json
        }
        Insert: {
          actor_id: string
          alias_id: string
          created_at?: string
          idempotency_key: string
          request_fingerprint: string
          response: Json
        }
        Update: {
          actor_id?: string
          alias_id?: string
          created_at?: string
          idempotency_key?: string
          request_fingerprint?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "vendor_alias_stage_receipts_alias_id_fkey"
            columns: ["alias_id"]
            isOneToOne: true
            referencedRelation: "vendor_aliases"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_aliases: {
        Row: {
          alias_display: string
          alias_normalized: string | null
          alias_raw: string
          created_at: string
          created_by: string | null
          id: string
          idempotency_key: string | null
          proposed_vendor_id: string | null
          request_fingerprint: string | null
          review_note: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          alias_display: string
          alias_normalized?: string | null
          alias_raw: string
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key?: string | null
          proposed_vendor_id?: string | null
          request_fingerprint?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          alias_display?: string
          alias_normalized?: string | null
          alias_raw?: string
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key?: string | null
          proposed_vendor_id?: string | null
          request_fingerprint?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_aliases_proposed_vendor_id_fkey"
            columns: ["proposed_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_aliases_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_aliases_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_bills: {
        Row: {
          adjustment_cents: number | null
          balance_cents: number | null
          bill_date: string
          bill_number: string
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          due_date: string
          id: string
          notes: string | null
          paid_cents: number | null
          payment_terms: string | null
          purchase_order_id: string | null
          status: string
          subtotal_cents: number
          total_cents: number
          updated_at: string | null
          vendor_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          adjustment_cents?: number | null
          balance_cents?: number | null
          bill_date: string
          bill_number: string
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          due_date: string
          id?: string
          notes?: string | null
          paid_cents?: number | null
          payment_terms?: string | null
          purchase_order_id?: string | null
          status?: string
          subtotal_cents: number
          total_cents: number
          updated_at?: string | null
          vendor_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          adjustment_cents?: number | null
          balance_cents?: number | null
          bill_date?: string
          bill_number?: string
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          due_date?: string
          id?: string
          notes?: string | null
          paid_cents?: number | null
          payment_terms?: string | null
          purchase_order_id?: string | null
          status?: string
          subtotal_cents?: number
          total_cents?: number
          updated_at?: string | null
          vendor_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_bills_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_payments: {
        Row: {
          amount_cents: number
          created_at: string | null
          created_by: string | null
          id: string
          notes: string | null
          payment_date: string
          payment_method: string | null
          reference_number: string | null
          vendor_bill_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date: string
          payment_method?: string | null
          reference_number?: string | null
          vendor_bill_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: string | null
          reference_number?: string | null
          vendor_bill_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_payments_vendor_bill_id_fkey"
            columns: ["vendor_bill_id"]
            isOneToOne: false
            referencedRelation: "vendor_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_payments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address: string | null
          contact_name: string | null
          created_at: string | null
          default_payment_terms: string | null
          default_payment_terms_days: number | null
          deleted_at: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          contact_name?: string | null
          created_at?: string | null
          default_payment_terms?: string | null
          default_payment_terms_days?: number | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          contact_name?: string | null
          created_at?: string | null
          default_payment_terms?: string | null
          default_payment_terms_days?: number | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      warehouses: {
        Row: {
          address: string | null
          city: string | null
          code: string | null
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          city?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          city?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          state?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      watchdog_flag_dismissals: {
        Row: {
          dismissed_at: string
          dismissed_by: string
          flag_id: string
          id: string
          note: string | null
          resolution: string
        }
        Insert: {
          dismissed_at?: string
          dismissed_by: string
          flag_id: string
          id?: string
          note?: string | null
          resolution: string
        }
        Update: {
          dismissed_at?: string
          dismissed_by?: string
          flag_id?: string
          id?: string
          note?: string | null
          resolution?: string
        }
        Relationships: [
          {
            foreignKeyName: "watchdog_flag_dismissals_dismissed_by_fkey"
            columns: ["dismissed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "watchdog_flag_dismissals_flag_id_fkey"
            columns: ["flag_id"]
            isOneToOne: false
            referencedRelation: "watchdog_flags"
            referencedColumns: ["id"]
          },
        ]
      }
      watchdog_flags: {
        Row: {
          created_at: string
          customer_id: string | null
          detail: Json | null
          entity_id: string
          entity_type: string
          field_id: string | null
          flag_type: string
          id: string
          invoice_id: string | null
          job_id: string | null
          message: string
          natural_key: string | null
          product_id: string | null
          severity: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          detail?: Json | null
          entity_id: string
          entity_type: string
          field_id?: string | null
          flag_type: string
          id?: string
          invoice_id?: string | null
          job_id?: string | null
          message: string
          natural_key?: string | null
          product_id?: string | null
          severity?: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          detail?: Json | null
          entity_id?: string
          entity_type?: string
          field_id?: string | null
          flag_type?: string
          id?: string
          invoice_id?: string | null
          job_id?: string | null
          message?: string
          natural_key?: string | null
          product_id?: string | null
          severity?: string
        }
        Relationships: []
      }
      write_offs: {
        Row: {
          amount_cents: number
          approved_by: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          invoice_id: string
          reason: string
          reversed_at: string | null
          reversed_by: string | null
          reversed_reason: string | null
        }
        Insert: {
          amount_cents: number
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          invoice_id: string
          reason: string
          reversed_at?: string | null
          reversed_by?: string | null
          reversed_reason?: string | null
        }
        Update: {
          amount_cents?: number
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          invoice_id?: string
          reason?: string
          reversed_at?: string | null
          reversed_by?: string | null
          reversed_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "write_offs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "write_offs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "write_offs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "write_offs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "write_offs_reversed_by_fkey"
            columns: ["reversed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      profile_public_view: {
        Row: {
          full_name: string | null
          id: string | null
          is_active: boolean | null
          role: string | null
        }
        Insert: {
          full_name?: string | null
          id?: string | null
          is_active?: boolean | null
          role?: string | null
        }
        Update: {
          full_name?: string | null
          id?: string | null
          is_active?: boolean | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_public_directory_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      view_unmigrated_products: {
        Row: {
          category: string | null
          container_size: number | null
          container_type: string | null
          container_unit: string | null
          id: string | null
          inventory_unit: string | null
          product_form: string | null
          product_name: string | null
          rate_unit: string | null
          sku: string | null
          unit_size: string | null
          vendor: string | null
        }
        Insert: {
          category?: string | null
          container_size?: number | null
          container_type?: string | null
          container_unit?: string | null
          id?: string | null
          inventory_unit?: string | null
          product_form?: string | null
          product_name?: string | null
          rate_unit?: string | null
          sku?: string | null
          unit_size?: string | null
          vendor?: string | null
        }
        Update: {
          category?: string | null
          container_size?: number | null
          container_type?: string | null
          container_unit?: string | null
          id?: string | null
          inventory_unit?: string | null
          product_form?: string | null
          product_name?: string | null
          rate_unit?: string | null
          sku?: string | null
          unit_size?: string | null
          vendor?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      __plpgsql_show_dependency_tb:
        | {
            Args: {
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              funcoid: unknown
              relid?: unknown
            }
            Returns: {
              name: string
              oid: unknown
              params: string
              schema: string
              type: string
            }[]
          }
        | {
            Args: {
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              name: string
              relid?: unknown
            }
            Returns: {
              name: string
              oid: unknown
              params: string
              schema: string
              type: string
            }[]
          }
      _apply_product_cost_basis_change_set_serialized_inner: {
        Args: {
          p_change_set_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_request_fingerprint: string
        }
        Returns: Json
      }
      _batch_apply_prepayments_impl: {
        Args: {
          p_allocations: Json
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      _bind_completed_lifecycle_idempotency: {
        Args: {
          p_contract: string
          p_key: string
          p_operation: string
          p_request: Json
          p_request_fingerprint: string
          p_response: Json
        }
        Returns: undefined
      }
      _calculate_product_pricing: {
        Args: {
          p_current_cost: number
          p_mode: string
          p_tier1_margin: number
          p_tier1_price: number
          p_tier2_margin: number
          p_tier2_price: number
          p_tier3_margin: number
          p_tier3_price: number
        }
        Returns: Json
      }
      _cancel_order_idem_impl_20260721: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _cancel_order_impl_20260714: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _cancel_order_provenance_wrapper_20260719: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _cancel_order_split_provenance_impl_20260719: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _check_credit_limit: {
        Args: { p_additional_cents?: number; p_customer_id: string }
        Returns: undefined
      }
      _claim_bound_lifecycle_idempotency: {
        Args: {
          p_contract: string
          p_key: string
          p_operation: string
          p_request: Json
          p_request_fingerprint: string
        }
        Returns: Json
      }
      _close_undelivered_order_remainder_20260718: {
        Args: { p_actor: string; p_order_id: string }
        Returns: Json
      }
      _complete_cycle_count_impl: {
        Args: {
          p_completed_by?: string
          p_cycle_count_id: string
          p_idempotency_key?: string
        }
        Returns: undefined
      }
      _complete_delivery_aggregate_impl: {
        Args: {
          p_completed_at?: string
          p_delivery_id: string
          p_idempotency_key?: string
          p_issue_notes?: string
          p_issue_type?: string
          p_performed_by?: string
          p_quantities?: Json
          p_signed_by: string
        }
        Returns: Json
      }
      _complete_delivery_authorized_impl: {
        Args: {
          p_completed_at?: string
          p_delivery_id: string
          p_idempotency_key?: string
          p_issue_notes?: string
          p_issue_type?: string
          p_performed_by?: string
          p_quantities?: Json
          p_signed_by: string
        }
        Returns: Json
      }
      _complete_delivery_period_preflight_impl: {
        Args: {
          p_completed_at?: string
          p_delivery_id: string
          p_idempotency_key?: string
          p_issue_notes?: string
          p_issue_type?: string
          p_performed_by?: string
          p_quantities?: Json
          p_signed_by: string
        }
        Returns: Json
      }
      _convert_quote_to_order_owner_impl: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
        }
        Returns: Json
      }
      _create_commission_payment_intent_impl_20260809: {
        Args: {
          p_commission_ids: string[]
          p_idempotency_key?: string
          p_notes: string
          p_payment_date: string
          p_payment_method: string
          p_performed_by?: string
          p_reference: string
        }
        Returns: string
      }
      _create_invoice_for_unbilled_delivery_idem_impl_20260721: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _create_invoice_for_unbilled_delivery_impl_20260718: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _create_invoice_from_order_idem_impl_20260721: {
        Args: {
          p_idempotency_key?: string
          p_invoice_type?: string
          p_order_id: string
          p_salesman_id?: string
        }
        Returns: string
      }
      _create_invoice_from_order_impl_20260718: {
        Args: {
          p_idempotency_key?: string
          p_invoice_type?: string
          p_order_id: string
          p_salesman_id?: string
        }
        Returns: string
      }
      _create_quick_delivery_intent_impl_20260802: {
        Args: {
          p_customer_id: string
          p_delivery_notes?: string
          p_driver_id?: string
          p_idempotency_key?: string
          p_items: Json
          p_performed_by?: string
          p_scheduled_date?: string
          p_skip_invoice?: boolean
        }
        Returns: Json
      }
      _create_quote_version_owner_impl: {
        Args: {
          p_idempotency_key?: string
          p_method?: string
          p_performed_by: string
          p_quote_id: string
        }
        Returns: Json
      }
      _create_split_invoices_from_order_provenance_impl_20260719: {
        Args: {
          p_idempotency_key?: string
          p_invoice_type?: string
          p_order_id: string
          p_salesman_id?: string
        }
        Returns: string[]
      }
      _delete_invoices_split_provenance_impl_20260719: {
        Args: {
          p_idempotency_key?: string
          p_invoice_ids: string[]
          p_performed_by?: string
        }
        Returns: number
      }
      _format_pricing_dollars: { Args: { p_cents: number }; Returns: string }
      _format_pricing_margin_percent: {
        Args: { p_ratio: number }
        Returns: string
      }
      _generate_finance_charges_idem_impl_20260721: {
        Args: {
          p_as_of_date: string
          p_customer_ids?: string[]
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      _get_customer_statement_scoped_impl: {
        Args: {
          p_customer_id: string
          p_end_date?: string
          p_start_date?: string
        }
        Returns: {
          amount_cents: number
          description: string
          reference_number: string
          running_balance: number
          transaction_date: string
          transaction_type: string
        }[]
      }
      _insert_commissions_for_job: {
        Args: {
          p_commission_date?: string
          p_commission_split: Json
          p_customer_id: string
          p_invoice_id: string
          p_job_id: string
          p_profit: number
        }
        Returns: number
      }
      _insert_commissions_for_order: {
        Args: {
          p_commission_split: Json
          p_customer_id: string
          p_order_date?: string
          p_order_id: string
          p_order_profit: number
        }
        Returns: number
      }
      _is_admin_override: { Args: never; Returns: boolean }
      _is_dispatched_to_me: { Args: { p_job_id: string }; Returns: boolean }
      _issue_return_credit_impl: {
        Args: {
          p_actor_id: string
          p_idempotency_key?: string
          p_return_id: string
        }
        Returns: Json
      }
      _lock_accounting_months: {
        Args: { p_dates: string[]; p_exclusive?: boolean }
        Returns: undefined
      }
      _lr_allocate_int: {
        Args: { p_total: number; p_weights: Json }
        Returns: Json
      }
      _parse_pricing_dollars: { Args: { p_value: string }; Returns: number }
      _parse_pricing_margin_percent: {
        Args: { p_value: string }
        Returns: number
      }
      _post_commission_payment_intent_impl_20260809: {
        Args: {
          p_idempotency_key?: string
          p_payment_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      _post_deleted_delivery_recovery_invoice_20260719: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
      _post_invoice_customer_scope_impl: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: undefined
      }
      _post_invoice_group_customer_scope_impl: {
        Args: {
          p_idempotency_key?: string
          p_invoice_group_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      _post_invoice_idem_impl_20260721: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: undefined
      }
      _post_invoice_impl_20260714: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: undefined
      }
      _post_invoice_public_impl_20260718: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: undefined
      }
      _product_cost_basis_row_required: {
        Args: {
          p_effect: Json
          p_row_status: string
          p_source: string
          p_submitted_row: Json
        }
        Returns: boolean
      }
      _purchase_order_item_unit_cost_cents: {
        Args: { p_item: Json }
        Returns: number
      }
      _receive_return_impl_20260714: {
        Args: {
          p_idempotency_key?: string
          p_received_by: string
          p_return_id: string
        }
        Returns: Json
      }
      _recompute_po_on_order_for_products: {
        Args: { p_product_ids: string[] }
        Returns: undefined
      }
      _require_auth: { Args: never; Returns: string }
      _resolve_product_cost_basis_row: { Args: { p_row: Json }; Returns: Json }
      _restore_quote_version_owner_impl: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_quote_id: string
          p_version_id: string
        }
        Returns: Json
      }
      _reverse_completed_cycle_count_impl: {
        Args: {
          p_cycle_count_id: string
          p_idempotency_key?: string
          p_reversed_by?: string
        }
        Returns: undefined
      }
      _reverse_credit_memo_application: {
        Args: {
          p_actor: string
          p_actor_role: string
          p_application_id: string
          p_reason: string
        }
        Returns: undefined
      }
      _save_field_app_invoice_impl_20260714: {
        Args: {
          p_application_service_id?: string
          p_chemicals: Json
          p_idempotency_key?: string
          p_invoice: Json
          p_invoice_id: string
          p_locations: Json
          p_performed_by: string
        }
        Returns: Json
      }
      _save_field_app_split_invoice_impl: {
        Args: {
          p_application_service_id: string
          p_billing_set_id: string
          p_fields: Json
          p_idempotency_key: string
          p_invoice: Json
          p_lines: Json
          p_performed_by: string
          p_request_hash: string
          p_source_job_id: string
        }
        Returns: Json
      }
      _save_invoice_governed_split_guard_impl_20260720: {
        Args: { p_idempotency_key?: string; p_invoice: Json; p_items?: Json }
        Returns: string
      }
      _save_invoice_intent_impl_20260802: {
        Args: { p_idempotency_key?: string; p_invoice: Json; p_items?: Json }
        Returns: string
      }
      _save_invoice_scoped_impl: {
        Args: { p_idempotency_key?: string; p_invoice: Json; p_items?: Json }
        Returns: string
      }
      _save_invoice_split_provenance_impl_20260719: {
        Args: { p_idempotency_key?: string; p_invoice: Json; p_items?: Json }
        Returns: string
      }
      _save_purchase_order_ascii_identity_impl: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
          p_po_id: string
          p_po_payload: Json
        }
        Returns: Json
      }
      _save_purchase_order_atomic_number_impl: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
          p_po_id: string
          p_po_payload: Json
        }
        Returns: Json
      }
      _save_purchase_order_cost_input_impl: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
          p_po_id: string
          p_po_payload: Json
        }
        Returns: Json
      }
      _section9_cancel_purchase_order_serialized: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_po_id: string
          p_reason?: string
        }
        Returns: Json
      }
      _section9_delete_purchase_order_serialized: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_po_id: string
        }
        Returns: Json
      }
      _section9_receive_po_items_serialized: {
        Args: {
          p_allow_over_receive?: boolean
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
        }
        Returns: Json
      }
      _section9_reverse_receiving_record_serialized: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason?: string
          p_record_id: string
        }
        Returns: Json
      }
      _section9_save_purchase_order_serialized: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
          p_po_id: string
          p_po_payload: Json
        }
        Returns: Json
      }
      _section9_submit_purchase_order_serialized: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_po_id: string
        }
        Returns: Json
      }
      _split_invoice_content_claim: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      _supplier_cost_basis_enabled_for_product: {
        Args: { p_product_id: string }
        Returns: boolean
      }
      _sync_job_holds: {
        Args: { p_actor: string; p_job_id: string }
        Returns: Json
      }
      _sync_planned_holds: {
        Args: { p_actor: string; p_quote_id: string }
        Returns: number
      }
      _sync_quote_job_reservations: {
        Args: { p_actor: string; p_quote_id: string }
        Returns: undefined
      }
      _update_order_items_impl: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_order_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      _void_commission_payment_intent_impl_20260809: {
        Args: {
          p_idempotency_key?: string
          p_payment_id: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      _void_invoice_group_guard_impl_20260720: {
        Args: {
          p_idempotency_key?: string
          p_invoice_id: string
          p_void_reason: string
        }
        Returns: undefined
      }
      _void_invoice_split_provenance_impl_20260719: {
        Args: {
          p_idempotency_key?: string
          p_invoice_id: string
          p_void_reason: string
        }
        Returns: undefined
      }
      _void_order_impl_20260714: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by: string
          p_reason?: string
        }
        Returns: Json
      }
      adjust_inventory: {
        Args: {
          p_delta: number
          p_idempotency_key?: string
          p_inventory_id: string
          p_performed_by: string
          p_reason: string
        }
        Returns: Json
      }
      admin_get_application_service_costs: {
        Args: { p_service_id?: string }
        Returns: {
          cost_per_acre_cents: string
          service_id: string
        }[]
      }
      admin_save_application_service: {
        Args: {
          p_cost_per_acre_cents: number
          p_default_rate_per_acre_cents: number
          p_idempotency_key?: string
          p_is_active: boolean
          p_name: string
          p_service_id: string
          p_sort_order: number
          p_vehicle_id: string
        }
        Returns: Json
      }
      admin_set_application_service_cost: {
        Args: {
          p_cost_per_acre_cents: number
          p_idempotency_key?: string
          p_service_id: string
        }
        Returns: Json
      }
      admin_update_profile: {
        Args: {
          new_denied_pages?: string[]
          new_full_name?: string
          new_is_active?: boolean
          new_phone?: string
          new_role?: string
          p_idempotency_key?: string
          target_user_id: string
        }
        Returns: Json
      }
      allocate_payment: {
        Args: {
          p_allocations?: Json
          p_check_number?: string
          p_customer_id: string
          p_idempotency_key?: string
          p_notes?: string
          p_payment_date?: string
          p_payment_method: string
          p_performed_by?: string
          p_reference_number?: string
          p_total_cents: number
        }
        Returns: Json
      }
      apply_credit_memo_to_invoice: {
        Args: {
          p_amount_cents: number
          p_credit_memo_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_target_invoice_id: string
        }
        Returns: string
      }
      apply_prepay_to_invoice: {
        Args: {
          p_amount_cents: number
          p_idempotency_key?: string
          p_invoice_id: string
          p_performed_by?: string
          p_prepay_credit_id: string
        }
        Returns: string
      }
      apply_product_cost_basis_change_set: {
        Args: {
          p_change_set_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_request_fingerprint: string
        }
        Returns: Json
      }
      apply_product_pricing_change_set: {
        Args: {
          p_change_set_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_request_fingerprint: string
        }
        Returns: Json
      }
      apply_remaining_prepayments: {
        Args: {
          p_customer_id: string
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      apply_write_off: {
        Args: {
          p_amount_cents: number
          p_idempotency_key?: string
          p_invoice_id: string
          p_performed_by: string
          p_reason: string
        }
        Returns: string
      }
      approve_return: {
        Args: {
          p_approved_by: string
          p_idempotency_key?: string
          p_return_id: string
        }
        Returns: Json
      }
      approve_supplier_price_import: {
        Args: {
          p_idempotency_key?: string
          p_import_id: string
          p_performed_by: string
          p_row_ids: string[]
        }
        Returns: Json
      }
      assert_customer_balance_reconstructable_as_of: {
        Args: { p_as_of_date: string; p_customer_id: string }
        Returns: undefined
      }
      assert_phase3_product_metadata_change_safe: {
        Args: { p_product_id: string }
        Returns: undefined
      }
      assert_phase3_return_policy: {
        Args: { p_product_ids: string[] }
        Returns: undefined
      }
      assign_customers_sales_rep: {
        Args: {
          p_customer_ids: string[]
          p_idempotency_key?: string
          p_sales_rep_id: string
        }
        Returns: Json
      }
      assign_job_applicator: {
        Args: {
          p_applicator_id?: string
          p_idempotency_key?: string
          p_job_id: string
          p_license_override?: boolean
          p_performed_by?: string
        }
        Returns: Json
      }
      auto_expire_quotes: { Args: never; Returns: Json }
      batch_apply_all_prepayments: {
        Args: { p_idempotency_key?: string; p_performed_by?: string }
        Returns: Json
      }
      batch_apply_prepayments: {
        Args: {
          p_allocations: Json
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      batch_approve_blend_tickets: {
        Args: {
          p_approved_by: string
          p_idempotency_key?: string
          p_ticket_ids: string[]
        }
        Returns: Json
      }
      batch_cancel_deliveries: {
        Args: {
          p_cancel_reason?: string
          p_delivery_ids: string[]
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: number
      }
      batch_post_invoices: {
        Args: { p_idempotency_key?: string; p_invoice_ids: string[] }
        Returns: Json
      }
      batch_reject_blend_tickets: {
        Args: {
          p_idempotency_key?: string
          p_rejected_by: string
          p_ticket_ids: string[]
        }
        Returns: Json
      }
      batch_reschedule_deliveries: {
        Args: {
          p_delivery_ids: string[]
          p_idempotency_key?: string
          p_new_date: string
          p_performed_by?: string
        }
        Returns: Json
      }
      batch_void_invoices: {
        Args: {
          p_idempotency_key?: string
          p_invoice_ids: string[]
          p_performed_by?: string
          p_void_reason: string
        }
        Returns: number
      }
      bulk_create_label_drafts: {
        Args: { p_drafts: Json; p_idempotency_key?: string }
        Returns: Json
      }
      bulk_import_order: {
        Args: {
          p_customer_id: string
          p_idempotency_key?: string
          p_items: Json
          p_notes?: string
          p_order_date: string
          p_order_number: string
          p_status: string
          p_total_cost: number
          p_total_margin_pct: number
          p_total_price: number
          p_total_profit: number
        }
        Returns: Json
      }
      calculate_billing_splits: {
        Args: { p_percentages: number[]; p_total_cents: number }
        Returns: number[]
      }
      cancel_cycle_count: {
        Args: {
          p_cycle_count_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      cancel_delivery: {
        Args: {
          p_cancel_reason: string
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      cancel_order: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      cancel_purchase_order: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_po_id: string
          p_reason?: string
        }
        Returns: Json
      }
      cancel_return: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_reason: string
          p_return_id: string
        }
        Returns: Json
      }
      check_customer_credit_limit: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      check_duplicate_blend_ticket: {
        Args: { p_ticket_date: string; p_ticket_number: string }
        Returns: {
          id: string
          review_status: string
          status: string
          ticket_date: string
          ticket_number: string
        }[]
      }
      check_duplicate_delivery: { Args: { p_order_id: string }; Returns: Json }
      check_idempotency: {
        Args: { p_key: string; p_operation: string }
        Returns: Json
      }
      check_idempotency_intent: {
        Args: {
          p_actor: string
          p_fingerprint: string
          p_key: string
          p_operation: string
        }
        Returns: Json
      }
      check_period_open: { Args: { p_date: string }; Returns: undefined }
      check_rate_limit: {
        Args: {
          p_max_calls?: number
          p_operation: string
          p_user_id: string
          p_window_seconds?: number
        }
        Returns: undefined
      }
      check_remainder_reminders: { Args: never; Returns: Json }
      check_unpriced_orders: { Args: never; Returns: Json }
      cleanup_rate_limits: { Args: never; Returns: undefined }
      close_accounting_period: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_period_end: string
        }
        Returns: Json
      }
      close_quote_as_applied: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
        }
        Returns: Json
      }
      close_quote_as_short: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
        }
        Returns: Json
      }
      commission_recipient_name_for_id: {
        Args: { p_id: string }
        Returns: string
      }
      commission_recipient_resolves: {
        Args: { p_recipient: string }
        Returns: boolean
      }
      commission_split_with_recipient_ids: {
        Args: { p_split: Json }
        Returns: Json
      }
      commit_blend_ticket_ocr_result: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_lease_token: string
          p_products: Json
          p_queue_id: string
          p_ticket_update: Json
        }
        Returns: Json
      }
      commit_label_draft: {
        Args: {
          p_decision: string
          p_draft_id: string
          p_epa_registration?: string
          p_force_overwrite?: boolean
          p_idempotency_key?: string
          p_max_label_rate?: number
          p_max_label_rate_unit?: string
          p_phi_days?: number
          p_rei_hours?: number
          p_signal_word?: string
        }
        Returns: Json
      }
      complete_cycle_count: {
        Args: {
          p_completed_by?: string
          p_cycle_count_id: string
          p_idempotency_key?: string
        }
        Returns: undefined
      }
      complete_delivery: {
        Args: {
          p_completed_at?: string
          p_delivery_id: string
          p_idempotency_key?: string
          p_issue_notes?: string
          p_issue_type?: string
          p_performed_by?: string
          p_quantities?: Json
          p_signed_by: string
        }
        Returns: Json
      }
      complete_job: {
        Args: {
          p_applied_info: Json
          p_idempotency_key?: string
          p_job_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      complete_team_note: {
        Args: {
          p_completed: boolean
          p_idempotency_key?: string
          p_note_id: string
        }
        Returns: Json
      }
      compute_application_service_fee: {
        Args: {
          p_acres: number
          p_customer_id: string
          p_season?: number
          p_service_id: string
        }
        Returns: Json
      }
      compute_commission_amount: {
        Args: { p_percentage: number; p_profit: number }
        Returns: number
      }
      compute_even_split_vector: {
        Args: { p_customer_ids: Json }
        Returns: Json
      }
      compute_fuel_surcharge_cents: {
        Args: { p_acres: number; p_subtotal_cents: number }
        Returns: number
      }
      compute_line_split_allocation: { Args: { p_line: Json }; Returns: Json }
      compute_season: { Args: { p_date: string }; Returns: number }
      confirm_delivery: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      confirm_job_notification_sent: {
        Args: {
          p_idempotency_key?: string
          p_message?: string
          p_notification_id: string
          p_performed_by?: string
          p_subject?: string
        }
        Returns: Json
      }
      consolidate_draft_invoices: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      convert_quote_to_order: {
        Args: {
          p_expected_row_version?: number
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
        }
        Returns: Json
      }
      convert_to_gl_lb: {
        Args: {
          p_product_form: string
          p_rate_unit: string
          p_total_applied: number
        }
        Returns: {
          converted_unit: string
          converted_value: number
        }[]
      }
      correct_supplier_price_observation: {
        Args: {
          p_corrected_cost: string
          p_idempotency_key?: string
          p_observation_id: string
          p_performed_by: string
          p_reason: string
        }
        Returns: Json
      }
      create_application_record_from_blend_ticket: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: string[]
      }
      create_blend_ticket: {
        Args: {
          p_enqueue_ocr?: boolean
          p_idempotency_key?: string
          p_images?: Json
          p_performed_by?: string
          p_products?: Json
          p_ticket_id: string
          p_ticket_payload: Json
        }
        Returns: Json
      }
      create_commission_payment: {
        Args: {
          p_commission_ids: string[]
          p_idempotency_key?: string
          p_notes: string
          p_payment_date: string
          p_payment_method: string
          p_performed_by?: string
          p_reference: string
        }
        Returns: string
      }
      create_delivery_with_items: {
        Args: {
          p_assigned_driver?: string
          p_customer_id: string
          p_delivery_address_id?: string
          p_delivery_notes?: string
          p_idempotency_key?: string
          p_items: Json
          p_order_id: string
          p_scheduled_date: string
          p_scheduled_time?: string
        }
        Returns: Json
      }
      create_direct_order: {
        Args: {
          p_customer_id: string
          p_customer_po_number?: string
          p_idempotency_key?: string
          p_items?: Json
          p_notes?: string
          p_order_date: string
          p_order_name?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      create_followup_delivery: {
        Args: {
          p_idempotency_key?: string
          p_original_delivery_id: string
          p_performed_by?: string
          p_scheduled_date?: string
        }
        Returns: Json
      }
      create_inventory_hold: {
        Args: {
          p_customer_id: string
          p_expires_at: string
          p_force?: boolean
          p_force_reason?: string
          p_hold_type: string
          p_idempotency_key?: string
          p_notes: string
          p_performed_by: string
          p_product_id: string
          p_quantity: number
        }
        Returns: Json
      }
      create_invoice_for_unbilled_delivery: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      create_invoice_from_blend_ticket: {
        Args: {
          p_blend_ticket_id: string
          p_created_by: string
          p_idempotency_key?: string
        }
        Returns: Json
      }
      create_invoice_from_order: {
        Args: {
          p_idempotency_key?: string
          p_invoice_type?: string
          p_order_id: string
          p_salesman_id?: string
        }
        Returns: string
      }
      create_job_from_quote_section: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_quote_id: string
          p_section_id: string
        }
        Returns: Json
      }
      create_label_draft: {
        Args: {
          p_confidence?: string
          p_epa_registration?: string
          p_idempotency_key?: string
          p_max_label_rate?: number
          p_max_label_rate_unit?: string
          p_phi_days?: number
          p_product_id: string
          p_rei_hours?: number
          p_signal_word?: string
          p_source_note?: string
          p_status?: string
        }
        Returns: string
      }
      create_order_from_blend_ticket: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_notes?: string
          p_order_date?: string
          p_order_number: string
          p_performed_by?: string
        }
        Returns: Json
      }
      create_planned_holds: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_quote_id: string
        }
        Returns: Json
      }
      create_prepay_check_splits: {
        Args: {
          p_customer_id: string
          p_expected_total_cents?: number
          p_idempotency_key?: string
          p_performed_by: string
          p_reference_number: string
          p_splits: Json
        }
        Returns: Json
      }
      create_pricing_workbook_export: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_product_ids?: string[]
        }
        Returns: Json
      }
      create_quick_delivery: {
        Args: {
          p_customer_id: string
          p_delivery_notes?: string
          p_driver_id?: string
          p_idempotency_key?: string
          p_items: Json
          p_performed_by?: string
          p_scheduled_date?: string
          p_skip_invoice?: boolean
        }
        Returns: Json
      }
      create_quote_from_template: {
        Args: {
          p_customer_id: string
          p_idempotency_key?: string
          p_performed_by: string
          p_template_id: string
        }
        Returns: Json
      }
      create_quote_version: {
        Args: {
          p_expected_row_version?: number
          p_idempotency_key?: string
          p_method?: string
          p_performed_by: string
          p_quote_id: string
        }
        Returns: Json
      }
      create_rebate_claim: {
        Args: {
          p_claim_amount_cents: number
          p_customer_id?: string
          p_idempotency_key?: string
          p_notes?: string
          p_order_id?: string
          p_product_id?: string
          p_program_id: string
          p_quantity: number
        }
        Returns: Json
      }
      create_return: {
        Args: { p_idempotency_key?: string; p_items?: Json; p_return: Json }
        Returns: Json
      }
      create_rush_order: {
        Args: {
          p_customer_id: string
          p_customer_po_number?: string
          p_idempotency_key?: string
          p_items?: Json
          p_notes?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      create_split_invoices_from_order: {
        Args: {
          p_idempotency_key?: string
          p_invoice_type?: string
          p_order_id: string
          p_salesman_id?: string
        }
        Returns: string[]
      }
      create_vendor_bill: {
        Args: {
          p_adjustment_cents?: number
          p_bill_date?: string
          p_bill_number?: string
          p_due_date?: string
          p_idempotency_key?: string
          p_notes?: string
          p_payment_terms?: string
          p_purchase_order_id?: string
          p_subtotal_cents?: number
          p_vendor_id: string
        }
        Returns: string
      }
      current_season: { Args: never; Returns: number }
      dashboard_summary: { Args: never; Returns: Json }
      delete_invoices: {
        Args: {
          p_idempotency_key?: string
          p_invoice_ids: string[]
          p_performed_by?: string
        }
        Returns: number
      }
      delete_prepay_credit: {
        Args: {
          p_credit_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      delete_purchase_order: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_po_id: string
        }
        Returns: Json
      }
      delete_vendor: {
        Args: { p_idempotency_key?: string; p_vendor_id: string }
        Returns: Json
      }
      derive_customer_shares_from_fields: {
        Args: { p_applied_acres_map?: Json; p_field_ids: string[] }
        Returns: Json
      }
      dismiss_watchdog_flag: {
        Args: {
          p_flag_id: string
          p_idempotency_key?: string
          p_note?: string
          p_performed_by?: string
          p_resolution: string
        }
        Returns: Json
      }
      dispatch_job_locations: {
        Args: {
          p_assignments: Json
          p_idempotency_key?: string
          p_license_override?: boolean
          p_performed_by?: string
        }
        Returns: Json
      }
      draw_down_quote: {
        Args: {
          p_draws: Json
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
        }
        Returns: Json
      }
      duplicate_quote: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_source_quote_id: string
        }
        Returns: Json
      }
      edit_delivery: {
        Args: {
          p_assigned_driver?: string
          p_delivery_address_id?: string
          p_delivery_id: string
          p_delivery_notes?: string
          p_delivery_window_end?: string
          p_delivery_window_start?: string
          p_idempotency_key?: string
          p_items?: Json
          p_performed_by?: string
          p_priority?: string
          p_scheduled_date?: string
          p_scheduled_time?: string
        }
        Returns: Json
      }
      edit_prepay_credit: {
        Args: {
          p_bucket_label?: string
          p_credit_id: string
          p_idempotency_key?: string
          p_new_balance_cents?: number
          p_notes?: string
          p_performed_by?: string
          p_reference_number?: string
        }
        Returns: Json
      }
      execute_sql_readonly: { Args: { sql_query: string }; Returns: Json }
      field_app_priced_quantity: {
        Args: {
          p_applied_qty: number
          p_inventory_unit: string
          p_product_form: string
          p_rate_unit: string
        }
        Returns: number
      }
      financial_dashboard_summary: { Args: never; Returns: Json }
      find_overlapping_fields: {
        Args: { p_boundary_geojson: string; p_customer_id?: string }
        Returns: Json
      }
      generate_batch_statements: {
        Args: {
          p_as_of_date: string
          p_idempotency_key?: string
          p_mode?: string
          p_performed_by: string
        }
        Returns: Json
      }
      generate_finance_charges: {
        Args: {
          p_as_of_date: string
          p_customer_ids?: string[]
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      generate_order_number: { Args: never; Returns: string }
      generate_quote_number: { Args: never; Returns: string }
      generate_rup_sales_records: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: number
      }
      generate_ticket_number: { Args: never; Returns: string }
      get_ap_aging: {
        Args: { p_as_of_date?: string }
        Returns: {
          bill_count: number
          current_amount: number
          days_1_30: number
          days_31_60: number
          days_61_90: number
          over_90: number
          total_outstanding: number
          vendor_id: string
          vendor_name: string
        }[]
      }
      get_ap_dashboard_summary: {
        Args: { p_idempotency_key?: string }
        Returns: Json
      }
      get_ar_aging: {
        Args: { p_as_of_date?: string }
        Returns: {
          current_amount: number
          customer_id: string
          days_30: number
          days_60: number
          days_90: number
          farm_name: string
          open_credit_cents: number
          over_90: number
          prepay_balance_cents: number
          total_outstanding: number
        }[]
      }
      get_ar_reminder_candidates: { Args: never; Returns: Json }
      get_batch_year_end_summaries: {
        Args: { p_customer_ids: string[]; p_season: number }
        Returns: Json
      }
      get_booking_settlement: { Args: { p_quote_id: string }; Returns: Json }
      get_bottom_line_pnl: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          amount: number
          line_item: string
          pct_of_revenue: number
        }[]
      }
      get_call_list_lapsed_products: {
        Args: { p_rep_id?: string }
        Returns: Json
      }
      get_call_list_no_recent_contact: {
        Args: { p_days?: number; p_rep_id?: string }
        Returns: Json
      }
      get_call_list_prepay_prospects: {
        Args: { p_min_prior_spend_cents?: number; p_rep_id?: string }
        Returns: Json
      }
      get_call_list_stale_quotes: {
        Args: { p_days?: number; p_rep_id?: string }
        Returns: Json
      }
      get_call_list_unassigned_accounts: {
        Args: { p_rep_id?: string }
        Returns: Json
      }
      get_chemical_history: {
        Args: { p_end_date: string; p_product_id: string; p_start_date: string }
        Returns: {
          customer_name: string
          notes: string
          quantity: number
          reference_number: string
          total_amount: number
          transaction_date: string
          transaction_type: string
          unit: string
          unit_price: number
        }[]
      }
      get_commission_balance_report: {
        Args: { p_as_of_date: string }
        Returns: {
          outstanding_balance: number
          paid_count: number
          pending_count: number
          recipient_id: string
          recipient_name: string
          total_earned: number
          total_paid: number
        }[]
      }
      get_customer_balance_listing: {
        Args: { p_as_of_date: string }
        Returns: {
          customer_id: string
          farm_name: string
          invoice_count: number
          oldest_unpaid_date: string
          open_credit: number
          outstanding_balance: number
          prepay_applied: number
          total_invoiced: number
          total_paid: number
        }[]
      }
      get_customer_delivery_remainders: {
        Args: { p_customer_id?: string }
        Returns: Json
      }
      get_customer_farm_group: {
        Args: { p_customer_id: string }
        Returns: {
          farm_name: string
          id: string
          is_parent: boolean
        }[]
      }
      get_customer_lapsed_products: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      get_customer_prep_card: { Args: { p_customer_id: string }; Returns: Json }
      get_customer_purchase_summary: {
        Args: { p_customer_id: string; p_season?: string }
        Returns: Json
      }
      get_customer_statement: {
        Args: {
          p_customer_id: string
          p_end_date?: string
          p_start_date?: string
        }
        Returns: {
          amount_cents: number
          description: string
          reference_number: string
          running_balance: number
          transaction_date: string
          transaction_type: string
        }[]
      }
      get_customer_summary: { Args: { p_customer_id: string }; Returns: Json }
      get_customer_transaction_review: {
        Args: {
          p_customer_id: string
          p_end_date: string
          p_start_date: string
        }
        Returns: {
          credit_cents: number
          debit_cents: number
          description: string
          reference_number: string
          running_balance_cents: number
          transaction_date: string
          transaction_type: string
        }[]
      }
      get_customer_year_end_summary: {
        Args: { p_customer_id: string; p_season: number }
        Returns: Json
      }
      get_dashboard_action_items: { Args: { p_limit?: number }; Returns: Json }
      get_detailed_statement_data: {
        Args: { p_as_of_date: string; p_customer_id: string; p_mode?: string }
        Returns: Json
      }
      get_dispatch_board_jobs: {
        Args: {
          p_applicator_id: string
          p_end_date?: string
          p_start_date?: string
          p_status?: string
        }
        Returns: Json[]
      }
      get_dispatch_stock_status: {
        Args: { p_job_ids: string[] }
        Returns: Json
      }
      get_dispatched_list: {
        Args: { p_applicator_id?: string; p_crew_id?: string }
        Returns: Json[]
      }
      get_expiring_planned_holds: {
        Args: { p_days_ahead?: number; p_idempotency_key?: string }
        Returns: Json
      }
      get_field_billing_splits_for_blend_ticket: {
        Args: { p_blend_ticket_id: string }
        Returns: {
          customer_id: string
          field_id: string
          is_primary: boolean
          split_pct: number
        }[]
      }
      get_field_billing_splits_for_order: {
        Args: { p_order_id: string }
        Returns: {
          customer_id: string
          field_id: string
          is_primary: boolean
          split_pct: number
        }[]
      }
      get_field_dashboard: {
        Args: { p_field_id: string; p_season?: number }
        Returns: Json
      }
      get_field_geojson: {
        Args: { p_field_id: string }
        Returns: {
          boundary_geojson: string
          centroid_geojson: string
        }[]
      }
      get_field_polygons: {
        Args: { p_field_id: string }
        Returns: {
          acres: number
          field_id: string
          id: string
          label: string
          polygon_geojson: Json
          sort_order: number
        }[]
      }
      get_field_profitability: {
        Args: { p_season?: string }
        Returns: {
          cost_cents: number
          customer_id: string
          customer_name: string
          field_id: string
          field_name: string
          margin_cents: number
          margin_per_acre_cents: number
          revenue_cents: number
          season: string
          total_acres_applied: number
        }[]
      }
      get_fields_geojson_by_ids: {
        Args: { p_field_ids: string[] }
        Returns: {
          boundary_geojson: string
          centroid_geojson: string
          crop_type: string
          customer_id: string
          customer_name: string
          field_name: string
          id: string
          is_active: boolean
          measured_acres: number
          override_acres: number
          total_acres: number
        }[]
      }
      get_fields_with_geojson: {
        Args: { p_customer_id?: string }
        Returns: {
          boundary_geojson: string
          centroid_geojson: string
          child_count: number
          county: string
          created_at: string
          crop_type: string
          customer_id: string
          customer_name: string
          field_name: string
          fsa_farm_number: string
          fsa_field_number: string
          fsa_tract_number: string
          id: string
          irrigation: boolean
          is_active: boolean
          legal_description: string
          notes: string
          parent_field_id: string
          soil_type: string
          state: string
          total_acres: number
          updated_at: string
        }[]
      }
      get_gross_sales_report: {
        Args: { p_end_date: string; p_group_by?: string; p_start_date: string }
        Returns: {
          gross_profit: number
          group_name: string
          margin_pct: number
          order_count: number
          total_cost: number
          total_revenue: number
          units_sold: number
        }[]
      }
      get_inventory_cost_report: {
        Args: never
        Returns: {
          below_reorder: boolean
          category: string
          net_available: number
          product_id: string
          product_name: string
          quantity_available: number
          quantity_prebooked: number
          reorder_point: number
          sku: string
          total_cost_value: number
          unit_cost: number
          vendor: string
        }[]
      }
      get_inventory_forecast: {
        Args: { p_months_ahead?: number }
        Returns: Json
      }
      get_inventory_position: { Args: never; Returns: Json }
      get_job_billed_customers: {
        Args: { p_job_id: string }
        Returns: {
          account_number: string
          customer_id: string
          farm_name: string
          is_primary: boolean
        }[]
      }
      get_job_fields_with_geojson: {
        Args: { p_job_id: string }
        Returns: {
          boundary_geojson: string
          centroid_geojson: string
          customer_id: string
          field_name: string
          id: string
          measured_acres: number
          override_acres: number
          sort_order: number
          total_acres: number
        }[]
      }
      get_job_inventory_shortfalls: {
        Args: { p_days_ahead?: number }
        Returns: Json
      }
      get_job_proof_data: {
        Args: { p_customer_id?: string; p_job_id: string }
        Returns: Json
      }
      get_jobs_billed_customers: {
        Args: { p_job_ids: string[] }
        Returns: {
          account_number: string
          customer_id: string
          farm_name: string
          is_primary: boolean
          job_id: string
        }[]
      }
      get_label_coverage_report: { Args: never; Returns: Json }
      get_logbook_by_applicator: {
        Args: {
          p_applicator_id: string
          p_end_date: string
          p_start_date: string
        }
        Returns: {
          application_date: string
          application_time: string
          applicator_name: string
          created_at: string
          customer_name: string
          field_legal_description: string
          field_name: string
          invoice_number: string
          product_data: Json
          record_id: string
          record_number: string
          season: number
          source_type: string
          total_acres: number
          total_volume: number
          total_volume_unit: string
          vehicle_name: string
          vehicle_registration: string
          vehicle_type: string
          weather_conditions: Json
        }[]
      }
      get_logbook_by_customer: {
        Args: {
          p_customer_id: string
          p_end_date: string
          p_start_date: string
        }
        Returns: {
          application_date: string
          application_time: string
          applicator_name: string
          created_at: string
          customer_name: string
          field_legal_description: string
          field_name: string
          invoice_number: string
          product_data: Json
          record_id: string
          record_number: string
          season: number
          source_type: string
          total_acres: number
          total_volume: number
          total_volume_unit: string
          vehicle_name: string
          vehicle_registration: string
          vehicle_type: string
          weather_conditions: Json
        }[]
      }
      get_logbook_by_field: {
        Args: { p_end_date: string; p_field_id: string; p_start_date: string }
        Returns: {
          application_date: string
          application_time: string
          applicator_name: string
          created_at: string
          customer_name: string
          field_legal_description: string
          field_name: string
          invoice_number: string
          product_data: Json
          record_id: string
          record_number: string
          season: number
          source_type: string
          total_acres: number
          total_volume: number
          total_volume_unit: string
          vehicle_name: string
          vehicle_registration: string
          vehicle_type: string
          weather_conditions: Json
        }[]
      }
      get_logbook_faa: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: {
          application_date: string
          application_time: string
          applicator_license: string
          applicator_name: string
          created_at: string
          customer_name: string
          faa_certificate: string
          field_county: string
          field_legal_description: string
          field_name: string
          field_state: string
          invoice_number: string
          product_data: Json
          record_id: string
          record_number: string
          season: number
          total_acres: number
          total_volume: number
          total_volume_unit: string
          vehicle_category: string
          vehicle_name: string
          vehicle_registration: string
          weather_conditions: Json
        }[]
      }
      get_lot_application_trace: {
        Args: { p_lot_number: string }
        Returns: {
          application_date: string
          application_record_id: string
          applicator_id: string
          applicator_name: string
          customer_id: string
          customer_name: string
          field_names: string
          invoice_id: string
          lot_number: string
          product_id: string
          product_name: string
          quantity_from_lot: number
          record_number: string
          source_receiving_record_id: string
          unit: string
        }[]
      }
      get_monthly_summary: {
        Args: { p_period_end: string; p_period_start: string }
        Returns: Json
      }
      get_notes_for_entity: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: {
          assigned_to: string | null
          completed_at: string | null
          completed_by: string | null
          content: string | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          due_date: string | null
          id: string
          is_completed: boolean
          is_pinned: boolean
          last_escalated_at: string | null
          linked_entity_id: string | null
          linked_entity_type: string | null
          note_type: string
          priority: string
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "team_notes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_offline_action_review_queue: {
        Args: {
          p_include_resolved?: boolean
          p_limit?: number
          p_offset?: number
        }
        Returns: Json
      }
      get_offline_action_status: {
        Args: { p_client_action_id: string }
        Returns: Json
      }
      get_open_booking_rollover: {
        Args: { p_customer_id?: string; p_season?: number }
        Returns: Json
      }
      get_product_cost_basis_workspace: {
        Args: { p_product_id: string }
        Returns: Json
      }
      get_product_price_history: {
        Args: { p_product_id: string }
        Returns: Json
      }
      get_program_completion: { Args: { p_season?: number }; Returns: Json }
      get_receiving_log: {
        Args: {
          p_condition?: string
          p_date_from?: string
          p_date_to?: string
          p_limit?: number
          p_offset?: number
          p_received_by?: string
          p_vendor?: string
        }
        Returns: Json
      }
      get_receiving_summary: { Args: never; Returns: Json }
      get_recent_lots_for_product: {
        Args: { p_product_id: string }
        Returns: {
          last_received_at: string
          lot_number: string
          receiving_record_id: string
          source: string
        }[]
      }
      get_rep_customer_purchase_flags: {
        Args: { p_season?: string }
        Returns: {
          customer_id: string
          farm_name: string
          lapsed: boolean
          last_season_cents: number
          this_season_cents: number
        }[]
      }
      get_rup_sales_register: {
        Args: {
          p_compliance_status?: string
          p_customer_id?: string
          p_end_date?: string
          p_include_voided?: boolean
          p_product_id?: string
          p_start_date?: string
        }
        Returns: {
          buyer_certification_expiry: string
          buyer_certification_number: string
          buyer_certification_type: string
          buyer_name: string
          compliance_notes: string
          compliance_status: string
          customer_id: string
          epa_registration: string
          id: string
          invoice_id: string
          product_name: string
          quantity: number
          sale_date: string
          season: number
          signal_word: string
          total_cents: number
          unit: string
          unit_price_cents: number
          void_reason: string
          voided_at: string
          voided_by: string
        }[]
      }
      get_sales_detail_report: {
        Args: {
          p_category?: string
          p_customer_ids?: string[]
          p_end_date?: string
          p_product_id?: string
          p_sales_rep_id?: string
          p_season?: number
          p_start_date?: string
        }
        Returns: {
          category: string
          cost: number
          customer_id: string
          customer_name: string
          invoice_number: string
          margin_pct: number
          order_date: string
          order_number: string
          product_id: string
          product_name: string
          profit: number
          quantity: number
          sales_rep_name: string
          season: number
          sku: string
          total_price: number
          unit: string
          unit_price: number
        }[]
      }
      get_sales_summary_report: {
        Args: {
          p_category?: string
          p_customer_ids?: string[]
          p_end_date?: string
          p_group_by?: string
          p_product_id?: string
          p_sales_rep_id?: string
          p_season?: number
          p_start_date?: string
        }
        Returns: {
          group_id: string
          group_key: string
          line_count: number
          margin_pct: number
          order_count: number
          total_cost: number
          total_profit: number
          total_quantity: number
          total_revenue: number
        }[]
      }
      get_season_comparison: {
        Args: { p_season_a: number; p_season_b: number }
        Returns: {
          change_pct: number
          metric: string
          season_a_val: number
          season_b_val: number
        }[]
      }
      get_supplier_market_evidence: {
        Args: { p_product_ids?: string[] }
        Returns: Json
      }
      get_supplier_price_import: {
        Args: { p_import_id: string }
        Returns: Json
      }
      get_supplier_pricing_workspace: {
        Args: { p_product_id?: string; p_vendor_id?: string }
        Returns: Json
      }
      get_supplier_quote_sheet: { Args: { p_vendor_id: string }; Returns: Json }
      get_team_board_deliveries: { Args: never; Returns: Json }
      get_team_workload: { Args: never; Returns: Json }
      get_watchdog_flags: {
        Args: {
          p_flag_type?: string
          p_include_dismissed?: boolean
          p_invoice_id?: string
          p_job_id?: string
        }
        Returns: {
          created_at: string
          customer_id: string
          detail: Json
          dismiss_note: string
          dismissed_at: string
          dismissed_by: string
          entity_id: string
          entity_type: string
          field_id: string
          flag_type: string
          id: string
          invoice_id: string
          is_dismissed: boolean
          job_id: string
          message: string
          product_id: string
          resolution: string
          severity: string
        }[]
      }
      get_yesterday_delivery_recap: { Args: never; Returns: Json }
      global_search: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          entity_type: string
          id: string
          primary_text: string
          secondary_text: string
        }[]
      }
      increment_customer_prepay: {
        Args: {
          p_amount_cents: number
          p_customer_id: string
          p_idempotency_key?: string
        }
        Returns: undefined
      }
      is_active_profile: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_applicator: { Args: never; Returns: boolean }
      is_driver: { Args: never; Returns: boolean }
      is_sales_rep: { Args: never; Returns: boolean }
      issue_return_credit: {
        Args: {
          p_actor_id: string
          p_idempotency_key?: string
          p_return_id: string
        }
        Returns: Json
      }
      link_blend_ticket_to_order: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_item_mappings?: Json
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      link_fields_to_parent: {
        Args: {
          p_child_ids: string[]
          p_idempotency_key?: string
          p_parent_id: string
          p_performed_by?: string
        }
        Returns: undefined
      }
      list_commission_recipients: {
        Args: never
        Returns: {
          full_name: string
          id: string
        }[]
      }
      load_recipe_into_job: {
        Args: {
          p_idempotency_key?: string
          p_job_id: string
          p_recipe_id: string
        }
        Returns: Json
      }
      lock_phase3_product_policy_products: {
        Args: { p_product_ids: string[] }
        Returns: undefined
      }
      log_customer_fact: {
        Args: {
          p_category: string
          p_confidence?: number
          p_customer_id: string
          p_expires_at?: string
          p_fact_key: string
          p_idempotency_key?: string
          p_save_verified?: boolean
          p_value_json?: Json
          p_value_text?: string
        }
        Returns: Json
      }
      log_customer_interaction: {
        Args: {
          p_contact_id?: string
          p_customer_id: string
          p_direction: string
          p_duration_seconds?: number
          p_follow_up_assigned_to?: string
          p_follow_up_content?: string
          p_follow_up_due_date?: string
          p_follow_up_title?: string
          p_idempotency_key?: string
          p_interaction_type: string
          p_occurred_at: string
          p_outcome?: string
          p_summary: string
        }
        Returns: Json
      }
      log_failed_notification: {
        Args: {
          p_entity_id?: string
          p_entity_type?: string
          p_error_message?: string
          p_idempotency_key?: string
          p_notification_type: string
          p_payload?: Json
        }
        Returns: string
      }
      manual_inventory_add: {
        Args: {
          p_idempotency_key?: string
          p_location: string
          p_min_stock_level?: number
          p_notes?: string
          p_performed_by?: string
          p_product_id: string
          p_quantity: number
          p_reorder_point?: number
          p_unit_cost?: number
          p_unit_size?: string
        }
        Returns: Json
      }
      mark_inventory_row_verified: {
        Args: {
          p_idempotency_key?: string
          p_inventory_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      mark_overdue_invoices: { Args: never; Returns: Json }
      match_quick_receive_items: {
        Args: { p_items: Json; p_vendor?: string }
        Returns: Json
      }
      next_application_record_number: { Args: never; Returns: string }
      next_commission_payment_number: { Args: never; Returns: string }
      next_cycle_count_number: { Args: never; Returns: string }
      next_delivery_number: { Args: never; Returns: string }
      next_invoice_number: {
        Args: { p_invoice_type?: string }
        Returns: string
      }
      next_job_number: { Args: never; Returns: string }
      next_po_number: { Args: never; Returns: string }
      next_return_number: { Args: never; Returns: string }
      normalize_phone_e164: {
        Args: { default_region?: string; raw: string }
        Returns: string
      }
      normalize_rate_unit: { Args: { p_unit: string }; Returns: string }
      normalize_vendor_alias: { Args: { p_value: string }; Returns: string }
      notify_damaged_receiving: {
        Args: {
          p_idempotency_key?: string
          p_items_summary: string
          p_po_id: string
          p_po_number: string
        }
        Returns: undefined
      }
      operational_dashboard_summary: { Args: never; Returns: Json }
      parse_payment_terms_days: { Args: { p_terms: string }; Returns: number }
      plpgsql_check_function:
        | {
            Args: {
              all_warnings?: boolean
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              compatibility_warnings?: boolean
              constant_tracing?: boolean
              extra_warnings?: boolean
              fatal_errors?: boolean
              format?: string
              funcoid: unknown
              incomment_options_usage_warning?: boolean
              newtable?: unknown
              oldtable?: unknown
              other_warnings?: boolean
              performance_warnings?: boolean
              relid?: unknown
              security_warnings?: boolean
              use_incomment_options?: boolean
              without_warnings?: boolean
            }
            Returns: string[]
          }
        | {
            Args: {
              all_warnings?: boolean
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              compatibility_warnings?: boolean
              constant_tracing?: boolean
              extra_warnings?: boolean
              fatal_errors?: boolean
              format?: string
              incomment_options_usage_warning?: boolean
              name: string
              newtable?: unknown
              oldtable?: unknown
              other_warnings?: boolean
              performance_warnings?: boolean
              relid?: unknown
              security_warnings?: boolean
              use_incomment_options?: boolean
              without_warnings?: boolean
            }
            Returns: string[]
          }
      plpgsql_check_function_tb:
        | {
            Args: {
              all_warnings?: boolean
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              compatibility_warnings?: boolean
              constant_tracing?: boolean
              extra_warnings?: boolean
              fatal_errors?: boolean
              funcoid: unknown
              incomment_options_usage_warning?: boolean
              newtable?: unknown
              oldtable?: unknown
              other_warnings?: boolean
              performance_warnings?: boolean
              relid?: unknown
              security_warnings?: boolean
              use_incomment_options?: boolean
              without_warnings?: boolean
            }
            Returns: {
              context: string
              detail: string
              functionid: unknown
              hint: string
              level: string
              lineno: number
              message: string
              position: number
              query: string
              sqlstate: string
              statement: string
            }[]
          }
        | {
            Args: {
              all_warnings?: boolean
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              compatibility_warnings?: boolean
              constant_tracing?: boolean
              extra_warnings?: boolean
              fatal_errors?: boolean
              incomment_options_usage_warning?: boolean
              name: string
              newtable?: unknown
              oldtable?: unknown
              other_warnings?: boolean
              performance_warnings?: boolean
              relid?: unknown
              security_warnings?: boolean
              use_incomment_options?: boolean
              without_warnings?: boolean
            }
            Returns: {
              context: string
              detail: string
              functionid: unknown
              hint: string
              level: string
              lineno: number
              message: string
              position: number
              query: string
              sqlstate: string
              statement: string
            }[]
          }
      plpgsql_check_pragma: { Args: { name: string[] }; Returns: number }
      plpgsql_check_profiler: { Args: { enable?: boolean }; Returns: boolean }
      plpgsql_check_tracer: {
        Args: { enable?: boolean; verbosity?: string }
        Returns: boolean
      }
      plpgsql_coverage_branches:
        | { Args: { funcoid: unknown }; Returns: number }
        | { Args: { name: string }; Returns: number }
      plpgsql_coverage_statements:
        | { Args: { funcoid: unknown }; Returns: number }
        | { Args: { name: string }; Returns: number }
      plpgsql_profiler_function_statements_tb:
        | {
            Args: { funcoid: unknown }
            Returns: {
              avg_time: number
              block_num: number
              exec_stmts: number
              exec_stmts_err: number
              lineno: number
              max_time: number
              parent_note: string
              parent_stmtid: number
              processed_rows: number
              queryid: number
              stmtid: number
              stmtname: string
              total_time: number
            }[]
          }
        | {
            Args: { name: string }
            Returns: {
              avg_time: number
              block_num: number
              exec_stmts: number
              exec_stmts_err: number
              lineno: number
              max_time: number
              parent_note: string
              parent_stmtid: number
              processed_rows: number
              queryid: number
              stmtid: number
              stmtname: string
              total_time: number
            }[]
          }
      plpgsql_profiler_function_tb:
        | {
            Args: { funcoid: unknown }
            Returns: {
              avg_time: number
              cmds_on_row: number
              exec_stmts: number
              exec_stmts_err: number
              lineno: number
              max_time: number[]
              processed_rows: number[]
              queryids: number[]
              source: string
              stmt_lineno: number
              total_time: number
            }[]
          }
        | {
            Args: { name: string }
            Returns: {
              avg_time: number
              cmds_on_row: number
              exec_stmts: number
              exec_stmts_err: number
              lineno: number
              max_time: number[]
              processed_rows: number[]
              queryids: number[]
              source: string
              stmt_lineno: number
              total_time: number
            }[]
          }
      plpgsql_profiler_functions_all: {
        Args: never
        Returns: {
          avg_time: number
          exec_count: number
          exec_stmts_err: number
          funcoid: unknown
          max_time: number
          min_time: number
          stddev_time: number
          total_time: number
        }[]
      }
      plpgsql_profiler_install_fake_queryid_hook: {
        Args: never
        Returns: undefined
      }
      plpgsql_profiler_remove_fake_queryid_hook: {
        Args: never
        Returns: undefined
      }
      plpgsql_profiler_reset: { Args: { funcoid: unknown }; Returns: undefined }
      plpgsql_profiler_reset_all: { Args: never; Returns: undefined }
      plpgsql_show_dependency_tb:
        | {
            Args: {
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              fnname: string
              relid?: unknown
            }
            Returns: {
              name: string
              oid: unknown
              params: string
              schema: string
              type: string
            }[]
          }
        | {
            Args: {
              anycompatiblerangetype?: unknown
              anycompatibletype?: unknown
              anyelememttype?: unknown
              anyenumtype?: unknown
              anyrangetype?: unknown
              funcoid: unknown
              relid?: unknown
            }
            Returns: {
              name: string
              oid: unknown
              params: string
              schema: string
              type: string
            }[]
          }
      post_commission_payment: {
        Args: {
          p_idempotency_key?: string
          p_payment_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      post_invoice: {
        Args: { p_idempotency_key?: string; p_invoice_id: string }
        Returns: undefined
      }
      post_invoice_group: {
        Args: {
          p_idempotency_key?: string
          p_invoice_group_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      preview_field_app_invoice_split: {
        Args: {
          p_application_service_id?: string
          p_chemicals: Json
          p_invoice_id?: string
          p_locations: Json
        }
        Returns: Json
      }
      preview_finance_charges: {
        Args: { p_as_of_date: string }
        Returns: {
          account_number: string
          charge_amount_cents: number
          charge_rate: number
          customer_id: string
          customer_name: string
          days_overdue: number
          finance_charge_enabled: boolean
          grace_days: number
          open_credit_cents: number
          overdue_balance_cents: number
        }[]
      }
      preview_product_cost_basis_changes: {
        Args: {
          p_export_id?: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_rows?: Json
          p_source: string
        }
        Returns: Json
      }
      preview_product_pricing_changes: {
        Args: {
          p_export_id?: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_rows?: Json
          p_source: string
        }
        Returns: Json
      }
      price_order: {
        Args: {
          p_idempotency_key?: string
          p_items?: Json
          p_order_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      process_offline_action: {
        Args: { p_client_action_id: string; p_idempotency_key?: string }
        Returns: Json
      }
      product_price_per_acre: {
        Args: {
          p_inventory_unit: string
          p_rate_per_acre: number
          p_rate_unit: string
          p_tier_price: number
          p_unit_size: string
        }
        Returns: number
      }
      reactivate_vendor: {
        Args: { p_idempotency_key?: string; p_vendor_id: string }
        Returns: Json
      }
      reassign_delivery: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_new_driver: string
          p_performed_by?: string
        }
        Returns: Json
      }
      receive_po_items: {
        Args: {
          p_allow_over_receive?: boolean
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
        }
        Returns: Json
      }
      receive_return: {
        Args: {
          p_idempotency_key?: string
          p_received_by: string
          p_return_id: string
        }
        Returns: Json
      }
      recompute_job_applied_acres: {
        Args: { p_job_id: string }
        Returns: undefined
      }
      reconcile_negative_inventory: {
        Args: {
          p_idempotency_key?: string
          p_inventory_id: string
          p_new_quantity: number
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      reconcile_prepay_balances: { Args: never; Returns: Json }
      record_invoice_payment: {
        Args: {
          p_amount_cents: number
          p_idempotency_key?: string
          p_invoice_id: string
          p_notes?: string
          p_payment_method: string
          p_reference_number?: string
        }
        Returns: string
      }
      record_job_post_notifications: {
        Args: {
          p_idempotency_key?: string
          p_job_id: string
          p_message: string
          p_performed_by?: string
          p_subject: string
        }
        Returns: Json
      }
      record_job_pre_notifications: {
        Args: {
          p_idempotency_key?: string
          p_job_id: string
          p_message: string
          p_performed_by?: string
          p_subject: string
        }
        Returns: Json
      }
      record_vendor_payment: {
        Args: {
          p_amount_cents: number
          p_idempotency_key?: string
          p_notes?: string
          p_payment_date?: string
          p_payment_method?: string
          p_reference_number?: string
          p_vendor_bill_id: string
        }
        Returns: string
      }
      refresh_watchdog_flags: {
        Args: {
          p_acre_divergence_threshold?: number
          p_job_id?: string
          p_rate_fallback_multiple?: number
        }
        Returns: Json
      }
      reject_return: {
        Args: {
          p_idempotency_key?: string
          p_rejected_by?: string
          p_return_id: string
        }
        Returns: Json
      }
      reject_supplier_price_import: {
        Args: {
          p_idempotency_key?: string
          p_import_id: string
          p_performed_by: string
          p_reason: string
        }
        Returns: Json
      }
      release_expired_quote_holds: { Args: never; Returns: Json }
      release_inventory_hold: {
        Args: {
          p_hold_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      reopen_accounting_period: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_period_id: string
          p_reason: string
        }
        Returns: Json
      }
      require_admin: { Args: never; Returns: undefined }
      require_admin_or_sales_rep: { Args: never; Returns: undefined }
      reserve_job_inventory: {
        Args: { p_job_id: string; p_performed_by?: string }
        Returns: Json
      }
      resolve_commission_recipient_id: {
        Args: { p_recipient: string }
        Returns: string
      }
      resolve_commission_split_recipient: {
        Args: { p_elem: Json; p_prefer_name?: boolean }
        Returns: string
      }
      resolve_field_app_chemical_price: {
        Args: {
          p_field_ids: string[]
          p_manual_price_cents?: number
          p_product_id: string
          p_tier: number
        }
        Returns: Json
      }
      resolve_line_split_vector: {
        Args: {
          p_applied_acres_map: Json
          p_field_ids: string[]
          p_source_job_id: string
        }
        Returns: Json
      }
      resolve_offline_action: {
        Args: {
          p_client_action_id: string
          p_idempotency_key?: string
          p_note: string
          p_resolution: string
        }
        Returns: Json
      }
      restore_cancelled_delivery: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      restore_cancelled_order: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      restore_quote_version: {
        Args: {
          p_expected_row_version?: number
          p_idempotency_key?: string
          p_performed_by: string
          p_quote_id: string
          p_version_id: string
        }
        Returns: Json
      }
      retire_inventory_item: {
        Args: {
          p_idempotency_key?: string
          p_inventory_id: string
          p_performed_by?: string
        }
        Returns: Json
      }
      retry_failed_notifications: { Args: never; Returns: Json }
      reverse_application_record: {
        Args: { p_application_record_id: string; p_idempotency_key?: string }
        Returns: Json
      }
      reverse_blend_ticket_approval: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
          p_ticket_id: string
        }
        Returns: Json
      }
      reverse_completed_cycle_count: {
        Args: {
          p_cycle_count_id: string
          p_idempotency_key?: string
          p_reversed_by?: string
        }
        Returns: undefined
      }
      reverse_credit_memo_application: {
        Args: {
          p_application_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      reverse_receiving_record: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason?: string
          p_record_id: string
        }
        Returns: Json
      }
      reverse_write_off: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
          p_write_off_id: string
        }
        Returns: Json
      }
      revert_quote_status: {
        Args: {
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
          p_reason: string
        }
        Returns: Json
      }
      review_customer_fact: {
        Args: {
          p_fact_id: string
          p_idempotency_key?: string
          p_review_note?: string
          p_verdict: string
        }
        Returns: Json
      }
      review_vendor_alias: {
        Args: {
          p_alias_id: string
          p_decision: string
          p_idempotency_key?: string
          p_performed_by: string
          p_review_note: string
          p_vendor_id: string
        }
        Returns: Json
      }
      rollover_quote_to_season: {
        Args: {
          p_idempotency_key?: string
          p_new_season: number
          p_performed_by: string
          p_quote_id: string
        }
        Returns: Json
      }
      run_data_integrity_sweep: { Args: never; Returns: Json }
      run_morning_notification_checks: { Args: never; Returns: undefined }
      run_weekly_db_backup: { Args: never; Returns: Json }
      safe_cents_qty: {
        Args: { p_cents: number; p_qty: number }
        Returns: number
      }
      save_blend_recipe: {
        Args: {
          p_crop_type?: string
          p_description?: string
          p_idempotency_key?: string
          p_items: Json
          p_name: string
          p_recipe_id: string
          p_recipe_type: string
          p_timing?: string
        }
        Returns: Json
      }
      save_blend_ticket: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_products: Json
          p_ticket_id: string
          p_ticket_payload: Json
        }
        Returns: Json
      }
      save_blend_ticket_fields: {
        Args: {
          p_blend_ticket_id: string
          p_fields: Json
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      save_customer: {
        Args: {
          p_addresses: Json
          p_customer_id: string
          p_customer_payload: Json
          p_idempotency_key?: string
          p_performed_by: string
        }
        Returns: Json
      }
      save_field: {
        Args: {
          p_billing_defaults?: Json
          p_field_id: string
          p_field_payload: Json
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: string
      }
      save_field_app_invoice: {
        Args: {
          p_application_service_id?: string
          p_chemicals: Json
          p_idempotency_key?: string
          p_invoice: Json
          p_invoice_id: string
          p_locations: Json
          p_performed_by: string
        }
        Returns: Json
      }
      save_field_app_split_invoice: {
        Args: {
          p_application_service_id?: string
          p_billing_set_id: string
          p_fields: Json
          p_idempotency_key?: string
          p_invoice: Json
          p_lines: Json
          p_performed_by: string
          p_source_job_id: string
        }
        Returns: Json
      }
      save_field_crop_history: {
        Args: {
          p_crop_type: string
          p_field_id: string
          p_harvest_date?: string
          p_idempotency_key?: string
          p_notes?: string
          p_performed_by?: string
          p_planting_date?: string
          p_season: number
          p_variety?: string
          p_yield_per_acre?: number
          p_yield_unit?: string
        }
        Returns: Json
      }
      save_field_geometry: {
        Args: {
          p_boundary_geojson?: string
          p_centroid_geojson?: string
          p_field_id: string
          p_idempotency_key?: string
        }
        Returns: undefined
      }
      save_field_polygons: {
        Args: {
          p_field_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_polygons: Json
        }
        Returns: undefined
      }
      save_idempotency: {
        Args: { p_key: string; p_operation: string; p_result: Json }
        Returns: undefined
      }
      save_invoice: {
        Args: { p_idempotency_key?: string; p_invoice: Json; p_items?: Json }
        Returns: string
      }
      save_job: {
        Args: {
          p_chemicals: Json
          p_fields: Json
          p_idempotency_key?: string
          p_job_id: string
          p_job_payload: Json
          p_performed_by: string
        }
        Returns: Json
      }
      save_job_applied_record: {
        Args: {
          p_crew?: Json
          p_fields: Json
          p_idempotency_key?: string
          p_record: Json
        }
        Returns: Json
      }
      save_purchase_order: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_performed_by: string
          p_po_id: string
          p_po_payload: Json
        }
        Returns: Json
      }
      save_quote: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_quote_id: string
          p_quote_payload: Json
          p_sections: Json
        }
        Returns: Json
      }
      save_quote_template: {
        Args: {
          p_description?: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_quote_id: string
          p_template_name: string
        }
        Returns: Json
      }
      save_vendor: {
        Args: {
          p_idempotency_key?: string
          p_payload: Json
          p_vendor_id: string
        }
        Returns: Json
      }
      season_end_date: { Args: { p_season: number }; Returns: string }
      season_start_date: { Args: { p_season: number }; Returns: string }
      set_application_record_lots: {
        Args: {
          p_application_record_id: string
          p_idempotency_key?: string
          p_lots: Json
          p_performed_by: string
        }
        Returns: Json
      }
      set_field_boundary: {
        Args: {
          p_boundary_geojson: string
          p_field_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      set_field_override_acres: {
        Args: {
          p_field_id: string
          p_idempotency_key?: string
          p_override_acres: number
          p_performed_by?: string
        }
        Returns: Json
      }
      set_primary_customer_contact: {
        Args: { p_contact_id: string; p_customer_id: string }
        Returns: Json
      }
      set_product_phase3_metadata: {
        Args: {
          p_expected_is_full_tote_only: boolean
          p_expected_packaging_variant: string
          p_expected_product_family_id: string
          p_expected_return_policy: string
          p_idempotency_key?: string
          p_is_full_tote_only: boolean
          p_packaging_variant: string
          p_product_family_id: string
          p_product_id: string
          p_return_policy: string
        }
        Returns: Json
      }
      settle_applied_record_acres: {
        Args: { p_record_id: string }
        Returns: undefined
      }
      stage_offline_action: {
        Args: {
          p_client_action_id: string
          p_client_created_at: string
          p_entity_id: string
          p_entity_snapshot_at?: string
          p_idempotency_key?: string
          p_operation: string
          p_payload: Json
          p_schema_version: number
        }
        Returns: Json
      }
      stage_supplier_price_import: {
        Args: {
          p_document_date: string
          p_format_version: string
          p_idempotency_key?: string
          p_ingestion_method: string
          p_performed_by: string
          p_rows: Json
          p_source_document_mime: string
          p_source_document_name: string
          p_source_document_path: string
          p_vendor_id: string
        }
        Returns: Json
      }
      stage_vendor_alias: {
        Args: {
          p_alias_display: string
          p_alias_raw: string
          p_idempotency_key?: string
          p_performed_by: string
          p_proposed_vendor_id: string
          p_source: string
        }
        Returns: Json
      }
      stamp_job_printed: {
        Args: { p_idempotency_key?: string; p_job_id: string }
        Returns: Json
      }
      start_job: {
        Args: {
          p_idempotency_key?: string
          p_job_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      statement_customer_has_later_balance_activity: {
        Args: { p_as_of_date: string; p_customer_id: string }
        Returns: boolean
      }
      statement_invoice_was_posted_as_of: {
        Args: {
          p_as_of_date: string
          p_current_posted_at: string
          p_invoice_id: string
        }
        Returns: boolean
      }
      submit_purchase_order: {
        Args: {
          p_idempotency_key?: string
          p_performed_by: string
          p_po_id: string
        }
        Returns: Json
      }
      supersede_customer_fact: {
        Args: {
          p_confidence: number
          p_expires_at: string
          p_fact_id: string
          p_idempotency_key?: string
          p_value_json: Json
          p_value_text: string
        }
        Returns: Json
      }
      transfer_invoice_to_job: {
        Args: {
          p_idempotency_key?: string
          p_invoice_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      transfer_job_to_invoice: {
        Args: {
          p_idempotency_key?: string
          p_job_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      transition_rebate_claim: {
        Args: {
          p_claim_id: string
          p_idempotency_key?: string
          p_manufacturer_ref?: string
          p_new_status: string
          p_paid_amount_cents?: number
        }
        Returns: Json
      }
      unapply_credit_memo: {
        Args: {
          p_credit_memo_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      undispatch_job_locations: {
        Args: {
          p_idempotency_key?: string
          p_job_field_ids: string[]
          p_performed_by?: string
        }
        Returns: Json
      }
      unlink_blend_ticket_from_order: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      unlink_field_from_parent: {
        Args: {
          p_field_id: string
          p_idempotency_key?: string
          p_performed_by?: string
        }
        Returns: undefined
      }
      unpost_invoice: {
        Args: {
          p_idempotency_key?: string
          p_invoice_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      unpost_invoice_group: {
        Args: {
          p_idempotency_key?: string
          p_invoice_group_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      update_blend_ticket_billing_status: {
        Args: {
          p_blend_ticket_id: string
          p_idempotency_key?: string
          p_payment_status?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      update_cycle_count_item: {
        Args: {
          p_counted_qty?: number
          p_idempotency_key?: string
          p_item_id: string
          p_notes?: string
          p_performed_by?: string
        }
        Returns: Json
      }
      update_field_app_applied_info: {
        Args: {
          p_applicator_name?: string
          p_diluent_rate_gpa?: number
          p_end_humidity_pct?: number
          p_end_temp_f?: number
          p_end_weather_source?: string
          p_end_weather_time?: string
          p_end_wind_direction?: string
          p_end_wind_mph?: number
          p_idempotency_key?: string
          p_invoice_ids: string[]
          p_performed_by?: string
          p_start_humidity_pct?: number
          p_start_temp_f?: number
          p_start_weather_source?: string
          p_start_weather_time?: string
          p_start_wind_direction?: string
          p_start_wind_mph?: number
          p_temperature_text?: string
          p_update_diluent?: boolean
          p_update_weather?: boolean
          p_weather_manual_override?: boolean
          p_wind_direction?: string
        }
        Returns: Json
      }
      update_field_app_invoice_billing: {
        Args: {
          p_discounts?: Json
          p_due_date?: string
          p_footer_notes?: string
          p_header_notes?: string
          p_idempotency_key?: string
          p_internal_notes?: string
          p_invoice_ids: string[]
          p_payment_terms?: string
          p_performed_by?: string
          p_purchase_order_ref?: string
        }
        Returns: Json
      }
      update_order_items: {
        Args: {
          p_idempotency_key?: string
          p_items: Json
          p_order_id: string
          p_performed_by: string
        }
        Returns: Json
      }
      update_vendor_bill: {
        Args: {
          p_adjustment_cents: number
          p_bill_date: string
          p_bill_id: string
          p_due_date: string
          p_idempotency_key?: string
          p_notes: string
          p_subtotal_cents: number
        }
        Returns: Json
      }
      upsert_product_supplier_link: {
        Args: {
          p_comparison_note: string
          p_comparison_status: string
          p_conversion_unit: string
          p_idempotency_key?: string
          p_inventory_units_per_supplier_unit: string
          p_is_preferred: boolean
          p_link_id?: string
          p_performed_by: string
          p_product_id: string
          p_supplier_pack_description: string
          p_supplier_product_name: string
          p_supplier_sku: string
          p_supplier_uom: string
          p_vendor_id: string
        }
        Returns: Json
      }
      validate_commission_split_json: {
        Args: { p_split: Json }
        Returns: undefined
      }
      void_commission_payment: {
        Args: {
          p_idempotency_key?: string
          p_payment_id: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      void_delivery: {
        Args: {
          p_delivery_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      void_invoice: {
        Args: {
          p_idempotency_key?: string
          p_invoice_id: string
          p_void_reason: string
        }
        Returns: undefined
      }
      void_invoice_group: {
        Args: {
          p_idempotency_key?: string
          p_invoice_group_id: string
          p_void_reason: string
        }
        Returns: number
      }
      void_order: {
        Args: {
          p_idempotency_key?: string
          p_order_id: string
          p_performed_by: string
          p_reason?: string
        }
        Returns: Json
      }
      void_payment: {
        Args: {
          p_allocation_set_id: string
          p_idempotency_key?: string
          p_performed_by?: string
          p_reason: string
        }
        Returns: Json
      }
      void_vendor_bill: {
        Args: {
          p_idempotency_key?: string
          p_reason?: string
          p_vendor_bill_id: string
        }
        Returns: undefined
      }
      void_vendor_payment: {
        Args: {
          p_idempotency_key?: string
          p_payment_id: string
          p_reason: string
        }
        Returns: Json
      }
    }
    Enums: {
      email_type:
        | "invoice"
        | "statement"
        | "order_confirmed"
        | "delivery_completed"
        | "quote"
        | "ar_reminder"
        | "low_stock_alert"
        | "month_end_close"
        | "pre_application_notice"
        | "post_application_notice"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      email_type: [
        "invoice",
        "statement",
        "order_confirmed",
        "delivery_completed",
        "quote",
        "ar_reminder",
        "low_stock_alert",
        "month_end_close",
        "pre_application_notice",
        "post_application_notice",
      ],
    },
  },
} as const
