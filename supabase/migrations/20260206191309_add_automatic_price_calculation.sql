/*
  # Automatic Price Calculation Based on Margins

  1. New Function
    - `calculate_prices_from_margin()` - Automatically recalculates tier prices when cost changes
    - Only recalculates if margin is set for that tier
    - Also recalculates per-acre prices if rate_per_acre is provided

  2. Changes
    - Adds trigger to products table that fires before INSERT or UPDATE
    - When current_cost changes and a tier has a margin set, automatically calculate the price
    - Formula: tier_price = current_cost * (1 + tier_margin)
    - Per-acre price = tier_price * rate_per_acre / container_size

  3. Security
    - Function runs with SECURITY DEFINER to allow automatic calculation
    - Only affects price fields when margins are set
*/

-- Function to automatically calculate prices based on margins
CREATE OR REPLACE FUNCTION calculate_prices_from_margin()
RETURNS TRIGGER AS $$
BEGIN
  -- Only calculate if current_cost is set
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    
    -- Calculate tier 1 price if margin is set
    IF NEW.tier1_margin IS NOT NULL THEN
      NEW.tier1_price := ROUND(NEW.current_cost * (1 + NEW.tier1_margin), 2);
      
      -- Calculate per-acre price for tier 1 if rate and container size are set
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier1_price_per_acre := ROUND((NEW.tier1_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    END IF;
    
    -- Calculate tier 2 price if margin is set
    IF NEW.tier2_margin IS NOT NULL THEN
      NEW.tier2_price := ROUND(NEW.current_cost * (1 + NEW.tier2_margin), 2);
      
      -- Calculate per-acre price for tier 2
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier2_price_per_acre := ROUND((NEW.tier2_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    END IF;
    
    -- Calculate tier 3 price if margin is set
    IF NEW.tier3_margin IS NOT NULL THEN
      NEW.tier3_price := ROUND(NEW.current_cost * (1 + NEW.tier3_margin), 2);
      
      -- Calculate per-acre price for tier 3
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier3_price_per_acre := ROUND((NEW.tier3_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger that runs before insert or update on products
DROP TRIGGER IF EXISTS trigger_calculate_prices_from_margin ON products;
CREATE TRIGGER trigger_calculate_prices_from_margin
  BEFORE INSERT OR UPDATE OF current_cost, tier1_margin, tier2_margin, tier3_margin, rate_per_acre, container_size
  ON products
  FOR EACH ROW
  EXECUTE FUNCTION calculate_prices_from_margin();
