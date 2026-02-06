/*
  # Fix Margin Terminology

  1. Changes
    - Correct the margin terminology and formulas
    - tier1_margin, tier2_margin, tier3_margin = Net Margin (input) = (Price - Cost) / Price
    - tier1_gross_margin, tier2_gross_margin, tier3_gross_margin = Gross Margin (display) = (Price - Cost) / Cost
  
  2. Formulas
    - Net Margin = (Price - Cost) / Price (e.g., 20% = $20 profit on $100 price)
    - Gross Margin = (Price - Cost) / Cost (e.g., 25% = $20 profit on $80 cost)
    - From Net Margin: Price = Cost / (1 - Net Margin)
    - Conversion: Gross Margin = Net Margin / (1 - Net Margin)

  3. Example
    - Input Net Margin: 20%
    - Cost: $80
    - Calculated Price: $80 / (1 - 0.20) = $80 / 0.80 = $100
    - Displayed Gross Margin: 0.20 / (1 - 0.20) = 0.20 / 0.80 = 0.25 = 25%
*/

-- Update the trigger function with corrected formulas
CREATE OR REPLACE FUNCTION calculate_prices_from_margin()
RETURNS TRIGGER AS $$
BEGIN
  -- Only calculate if current_cost is set
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    
    -- Calculate tier 1 price and margins if net margin is set
    IF NEW.tier1_margin IS NOT NULL AND NEW.tier1_margin < 1 AND NEW.tier1_margin > 0 THEN
      -- Calculate price from net margin: Price = Cost / (1 - Net Margin)
      NEW.tier1_price := ROUND(NEW.current_cost / (1 - NEW.tier1_margin), 2);
      
      -- Calculate gross margin for display: Gross = Net / (1 - Net)
      NEW.tier1_gross_margin := ROUND(NEW.tier1_margin / (1 - NEW.tier1_margin), 4);
      
      -- Calculate per-acre price for tier 1 if rate and container size are set
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier1_price_per_acre := ROUND((NEW.tier1_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier1_gross_margin := NULL;
    END IF;
    
    -- Calculate tier 2 price and margins if net margin is set
    IF NEW.tier2_margin IS NOT NULL AND NEW.tier2_margin < 1 AND NEW.tier2_margin > 0 THEN
      NEW.tier2_price := ROUND(NEW.current_cost / (1 - NEW.tier2_margin), 2);
      NEW.tier2_gross_margin := ROUND(NEW.tier2_margin / (1 - NEW.tier2_margin), 4);
      
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier2_price_per_acre := ROUND((NEW.tier2_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier2_gross_margin := NULL;
    END IF;
    
    -- Calculate tier 3 price and margins if net margin is set
    IF NEW.tier3_margin IS NOT NULL AND NEW.tier3_margin < 1 AND NEW.tier3_margin > 0 THEN
      NEW.tier3_price := ROUND(NEW.current_cost / (1 - NEW.tier3_margin), 2);
      NEW.tier3_gross_margin := ROUND(NEW.tier3_margin / (1 - NEW.tier3_margin), 4);
      
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
