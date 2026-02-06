/*
  # Add Gross Margin Display Alongside Net Margin

  1. New Columns
    - `tier1_gross_margin` - Calculated gross margin % for tier 1
    - `tier2_gross_margin` - Calculated gross margin % for tier 2
    - `tier3_gross_margin` - Calculated gross margin % for tier 3

  2. Changes
    - Adds gross margin columns to products table
    - Updates calculation trigger to compute gross margin from net margin
    - Net margin remains the input field (what you enter)
    - Gross margin is auto-calculated for display purposes

  3. Formulas
    - Net Margin = (Price - Cost) / Cost (e.g., 25% = $125 price on $100 cost)
    - Gross Margin = (Price - Cost) / Price (e.g., 20% = $25 profit on $125 price)
    - Conversion: Gross Margin = Net Margin / (1 + Net Margin)
*/

-- Add gross margin columns to products table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'tier1_gross_margin'
  ) THEN
    ALTER TABLE products ADD COLUMN tier1_gross_margin numeric;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'tier2_gross_margin'
  ) THEN
    ALTER TABLE products ADD COLUMN tier2_gross_margin numeric;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'tier3_gross_margin'
  ) THEN
    ALTER TABLE products ADD COLUMN tier3_gross_margin numeric;
  END IF;
END $$;

-- Update the trigger function to calculate both net and gross margins
CREATE OR REPLACE FUNCTION calculate_prices_from_margin()
RETURNS TRIGGER AS $$
BEGIN
  -- Only calculate if current_cost is set
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    
    -- Calculate tier 1 price and margins if net margin is set
    IF NEW.tier1_margin IS NOT NULL THEN
      -- Calculate price from net margin (markup)
      NEW.tier1_price := ROUND(NEW.current_cost * (1 + NEW.tier1_margin), 2);
      
      -- Calculate gross margin for display: Gross = Net / (1 + Net)
      NEW.tier1_gross_margin := ROUND(NEW.tier1_margin / (1 + NEW.tier1_margin), 4);
      
      -- Calculate per-acre price for tier 1 if rate and container size are set
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier1_price_per_acre := ROUND((NEW.tier1_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier1_gross_margin := NULL;
    END IF;
    
    -- Calculate tier 2 price and margins if net margin is set
    IF NEW.tier2_margin IS NOT NULL THEN
      NEW.tier2_price := ROUND(NEW.current_cost * (1 + NEW.tier2_margin), 2);
      NEW.tier2_gross_margin := ROUND(NEW.tier2_margin / (1 + NEW.tier2_margin), 4);
      
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier2_price_per_acre := ROUND((NEW.tier2_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier2_gross_margin := NULL;
    END IF;
    
    -- Calculate tier 3 price and margins if net margin is set
    IF NEW.tier3_margin IS NOT NULL THEN
      NEW.tier3_price := ROUND(NEW.current_cost * (1 + NEW.tier3_margin), 2);
      NEW.tier3_gross_margin := ROUND(NEW.tier3_margin / (1 + NEW.tier3_margin), 4);
      
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier3_price_per_acre := ROUND((NEW.tier3_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier3_gross_margin := NULL;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger already exists, no need to recreate
